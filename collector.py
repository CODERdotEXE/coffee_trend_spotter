"""
Brewscope data engine.

- Collects coffee conversation from YouTube (US/UK/India) + coffee RSS.
- ACCUMULATES into a persistent store (data/store.json), deduped by id, so the
  dataset grows with every sync and the time series gets longer.
- Auto-DISCOVERS competitor brands from the conversation (not hardcoded); only our
  own portfolio brands are declared (market-aware) in config.
- Classifies coffee types, scores sentiment, flags launches.
- FORECASTS each coffee format's weekly volume with SARIMA and computes an
  Impact Factor (projected momentum x reach x sentiment).
- Writes data/dataset.json for the web app.
"""

import os
import re
import json
import time
import math
from datetime import datetime, timezone, timedelta

import requests
from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer

HERE = os.path.dirname(os.path.abspath(__file__))
# DATA_DIR is overridable so the accumulation store can live on a persistent disk
# in production (e.g. Render disk mounted at /var/data). Defaults to ./data locally.
DATA_DIR = os.environ.get("BREWSCOPE_DATA") or os.path.join(HERE, "data")
DATASET = os.path.join(DATA_DIR, "dataset.json")
STORE = os.path.join(DATA_DIR, "store.json")
SEARCH_INTEREST = os.path.join(DATA_DIR, "search_interest.json")
PERCEPTION_INTEREST = os.path.join(DATA_DIR, "perception_interest.json")
ANALYZER = SentimentIntensityAnalyzer()

# Words that are never brands (generic / coffee vocabulary) for auto-discovery.
BRAND_STOP = set("""The A An And Or But Of To In On For With At By From Is Are This That New Best Top How What Why When
Make Making Made My Your You We Our I Vs Versus Review Reviews Recipe Recipes Taste Test Tasting Guide Tutorial Tips
Coffee Coffees Cup Cups Drink Drinks Iced Hot Cold Brew Brewed Brewing Espresso Latte Cappuccino Mocha Americano
Cortado Macchiato Decaf Roast Roasted Bean Beans Ground Whole Instant Nitro Foam Cream Milk Oat Almond Sugar Vanilla
Caramel Hazelnut Pumpkin Spice Matcha Drip Filter French Press Pour Over Aeropress Moka Pot Single Origin Dark Light
Medium Morning Home Easy Perfect Day Time Video Shorts Viral Trend Trending Try Trying Buy Worth Money Vs Using Use
Get Got Now Today Week Channel Subscribe Watch Part One Two Three First Second Better Good Great Amazing Ultimate
Vlog Asmr Diy Vs. Recipe. Day. Of. At. K Kcup Keurig Machine Maker Grinder Barista Cafe Shop Store House Blend""".split())


def load_config():
    with open(os.path.join(HERE, "config.json"), encoding="utf-8") as f:
        return json.load(f)


def load_brand_reference():
    p = os.path.join(HERE, "brands_reference.json")
    if os.path.exists(p):
        try:
            return json.load(open(p, encoding="utf-8")).get("brands", [])
        except Exception:
            pass
    return []


def load_credentials():
    creds = {}
    for p in [os.path.join(HERE, "..", "trend-spotter", "credentials.json"),
              os.path.join(HERE, "credentials.json")]:
        if os.path.exists(p):
            try:
                creds.update({k: v for k, v in json.load(open(p, encoding="utf-8")).items() if not k.startswith("_")})
            except Exception:
                pass
    for k in ["YOUTUBE_API_KEY", "REDDIT_CLIENT_ID", "REDDIT_CLIENT_SECRET", "REDDIT_USER_AGENT"]:
        if os.environ.get(k):
            creds[k] = os.environ[k]
    return creds


def youtube_key():
    return load_credentials().get("YOUTUBE_API_KEY")


def sentiment(t): return ANALYZER.polarity_scores(t or "")["compound"]
def label(s): return "positive" if s >= 0.05 else "negative" if s <= -0.05 else "neutral"
def _norm(s): return re.sub(r"['’]", "", (s or "").lower())
def parse_dt(s):
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")) if s else None
    except Exception:
        return None


def classify_types(text, cfg):
    low = _norm(text)
    types = [n for n, kws in cfg["coffee_types"].items()
             if any(re.search(r"\b" + re.escape(_norm(k)) + r"\b", low) for k in kws)]
    is_launch = any(k in low for k in cfg["launch_keywords"])
    return types, is_launch


# --- coffee perception themes (brand-agnostic: how coffee itself is talked about) ---
# Each theme = how people PERCEIVE coffee, independent of any brand/format. Keyword
# matched on title+description; a record can carry several themes.
PERCEPTION_THEMES = {
    "Health & Wellness": [
        "health", "healthy", "benefit", "benefits", "antioxidant", "antioxidants", "wellness",
        "nutrition", "nutritious", "metabolism", "metabolic", "longevity", "immune", "immunity",
        "gut health", "good for you", "good for your", "heart health", "lower risk",
        "anti-inflammatory", "polyphenol", "polyphenols", "fiber", "vitamin", "weight loss",
        "burn fat", "fasting", "blood sugar", "cholesterol", "liver", "brain health",
        "live longer", "is coffee good", "benefits of coffee", "healthiest"],
    "Side Effects & Concerns": [
        "jitter", "jitters", "jittery", "anxiety", "anxious", "crash", "insomnia", "cant sleep",
        "sleepless", "keeps me up", "addiction", "addicted", "addictive", "dependence", "dependent",
        "withdrawal", "acidity", "acidic", "heartburn", "acid reflux", "stomach", "bloating",
        "headache", "headaches", "migraine", "dehydrated", "dehydration", "palpitation",
        "palpitations", "cortisol", "stained teeth", "bad for", "harmful", "unhealthy",
        "side effect", "side effects", "quit coffee", "quitting coffee", "too much caffeine",
        "overconsumption", "racing heart", "is coffee bad", "decaf", "caffeine free",
        "caffeine-free", "low acid", "low-acid", "cut back"],
    "Energy & Productivity": [
        "energy", "energize", "energizing", "focus", "focused", "productivity", "productive",
        "alert", "alertness", "awake", "wake up", "wake me up", "boost", "concentration",
        "concentrate", "fuel", "motivation", "motivated", "pick me up", "pick-me-up",
        "kickstart", "study", "grind", "hustle", "all-nighter", "caffeine kick", "stay awake",
        "caffeine", "caffeinated", "need coffee", "morning coffee", "before coffee"],
    "Taste & Quality": [
        "taste", "tastes", "flavor", "flavour", "flavors", "flavours", "smooth", "rich",
        "aroma", "aromatic", "bitter", "bitterness", "quality", "specialty", "speciality",
        "artisan", "artisanal", "craft", "tasting notes", "delicious", "robust", "balanced",
        "mouthfeel", "freshly roasted", "fresh roast", "single origin", "premium", "gourmet",
        "smoothness", "well-rounded", "complex flavor"],
    "Sustainability & Ethics": [
        "sustainable", "sustainability", "ethical", "ethically", "fair trade", "fairtrade",
        "organic", "environment", "environmental", "environmentally", "carbon", "deforestation",
        "farmer", "farmers", "eco", "eco-friendly", "regenerative", "shade grown", "shade-grown",
        "bird friendly", "traceable", "traceability", "transparency", "climate", "rainforest",
        "compostable", "ethical sourcing", "direct trade"],
    "Price & Value": [
        "price", "prices", "expensive", "cheap", "cost", "costly", "worth it", "value",
        "inflation", "affordable", "affordability", "budget", "pricey", "overpriced", "splurge",
        "save money", "too expensive", "rip off", "rip-off", "bang for", "money", "dollars",
        "shrinkflation", "cost of living"],
    "Convenience & Ritual": [
        "instant", "quick", "on the go", "on-the-go", "ritual", "morning routine", "routine",
        "pods", "pod", "capsule", "capsules", "convenient", "convenience", "grab and go",
        "daily habit", "everyday", "easy to make", "effortless", "single serve", "single-serve",
        "ready to drink", "ready-to-drink", "rtd", "subscription"],
    "Culture & Lifestyle": [
        "cafe culture", "coffee culture", "aesthetic", "vibe", "vibes", "trend", "trending",
        "viral", "lifestyle", "social", "hangout", "third wave", "community", "tiktok",
        "instagram", "coffee shop", "coffee date", "cozy", "cottagecore", "romanticize",
        "romanticise", "self care", "self-care", "coffee snob", "coffee lover", "coffee addict"],
}
_PERCEPTION_PATS = {name: [re.compile(r"\b" + re.escape(_norm(k)) + r"\b") for k in kws]
                    for name, kws in PERCEPTION_THEMES.items()}


def tag_perception(records):
    """Tag each record with the perception themes it touches (brand-agnostic)."""
    for r in records:
        low = _norm(r.get("title", "") + " " + r.get("desc", ""))
        r["perception"] = [name for name, pats in _PERCEPTION_PATS.items()
                           if any(p.search(low) for p in pats)]


# --- collection ----------------------------------------------------------
def yt_search(key, q, region, after, progress):
    try:
        r = requests.get("https://www.googleapis.com/youtube/v3/search", params={
            "key": key, "q": q, "part": "snippet", "type": "video", "order": "relevance",
            "maxResults": 50, "regionCode": region, "relevanceLanguage": "en", "publishedAfter": after}, timeout=25)
        d = r.json()
        if "error" in d:
            progress(f"  YouTube error: {d['error'].get('message','?')[:80]}")
            return []
        return [it["id"]["videoId"] for it in d.get("items", []) if it.get("id", {}).get("videoId")]
    except Exception as e:
        progress(f"  YouTube '{q}' [{region}]: {e}")
        return []


def yt_details(key, ids):
    out = {}
    for i in range(0, len(ids), 50):
        try:
            r = requests.get("https://www.googleapis.com/youtube/v3/videos", params={
                "key": key, "id": ",".join(ids[i:i + 50]), "part": "snippet,statistics"}, timeout=25)
            for it in r.json().get("items", []):
                sn, st = it["snippet"], it.get("statistics", {})
                out[it["id"]] = {"title": sn.get("title", ""), "desc": sn.get("description", "")[:400],
                                 "channel": sn.get("channelTitle", ""), "published": sn.get("publishedAt", ""),
                                 "views": int(st.get("viewCount", 0)), "likes": int(st.get("likeCount", 0)),
                                 "comments": int(st.get("commentCount", 0))}
        except Exception:
            pass
    return out


def collect_youtube(cfg, key, progress):
    after = (datetime.now(timezone.utc) - timedelta(days=cfg["days_back"])).strftime("%Y-%m-%dT%H:%M:%SZ")
    region_ids = {}
    for region in cfg["regions"]:
        for q in cfg["search_queries"]:
            for vid in yt_search(key, q, region, after, progress):
                region_ids.setdefault(vid, set()).add(region)
            time.sleep(0.12)
        progress(f"  searched YouTube [{region}] ({len(region_ids)} videos)")
    details = yt_details(key, list(region_ids.keys()))
    progress(f"  pulled details for {len(details)} videos")
    out = []
    for vid, info in details.items():
        text = f"{info['title']} {info['desc']}"
        types, is_launch = classify_types(text, cfg)
        if not types:
            continue
        sc = sentiment(info["title"] + ". " + info["desc"])
        out.append({"id": "yt_" + vid, "title": info["title"], "url": f"https://youtube.com/watch?v={vid}",
                    "channel": info["channel"], "published": info["published"], "views": info["views"],
                    "likes": info["likes"], "comments": info["comments"],
                    "engagement": info["views"] + 10 * info["comments"] + 3 * info["likes"],
                    "sentiment": round(sc, 3), "sent": label(sc), "types": types,
                    "regions": sorted(region_ids.get(vid, [])), "is_launch": is_launch, "source": "youtube"})
    return out


def _rss_entry(e, cfg, regions, channel, source, idpfx):
    title = e.get("title", "")
    text = f"{title} {re.sub('<[^>]+>', ' ', e.get('summary', ''))}"
    types, is_launch = classify_types(text, cfg)
    if not types:
        return None
    pub = ""
    if getattr(e, "published_parsed", None):
        pub = datetime(*e.published_parsed[:6], tzinfo=timezone.utc).isoformat()
    sc = sentiment(text)
    return {"id": idpfx + (e.get("link", "") or title), "title": title, "url": e.get("link", ""),
            "channel": channel, "published": pub, "views": 0, "likes": 0, "comments": 0, "engagement": 0,
            "sentiment": round(sc, 3), "sent": label(sc), "types": types, "regions": regions,
            "is_launch": is_launch, "source": source}


def collect_rss(cfg, progress):
    try:
        import feedparser
    except ImportError:
        return []
    feeds = ["https://sprudge.com/feed", "https://dailycoffeenews.com/feed", "https://www.perfectdailygrind.com/feed/"]
    regions = list(cfg["regions"])
    out = []
    for url in feeds:
        try:
            for e in feedparser.parse(url).entries[:40]:
                rec = _rss_entry(e, cfg, regions, "Coffee press", "press", "rss_")
                if rec:
                    out.append(rec)
        except Exception:
            pass
    progress(f"  coffee press: {len(out)} articles")
    return out


def collect_google_news(cfg, progress):
    """Free, no key: per-market Google News RSS."""
    try:
        import feedparser
        import urllib.parse
    except ImportError:
        return []
    locale = {"US": ("en-US", "US"), "GB": ("en-GB", "GB"), "CA": ("en-CA", "CA"), "IN": ("en-IN", "IN")}
    queries = ["coffee", "cold brew", "new coffee", "coffee brand", "coffee launch", "iced coffee"]
    out = []
    for region in cfg["regions"]:
        hl, gl = locale.get(region, ("en-US", "US"))
        for q in queries:
            url = (f"https://news.google.com/rss/search?q={urllib.parse.quote(q)}%20when:45d"
                   f"&hl={hl}&gl={gl}&ceid={gl}:en")
            try:
                for e in feedparser.parse(url).entries[:25]:
                    rec = _rss_entry(e, cfg, [region], "Google News", "news", "gn_")
                    if rec:
                        out.append(rec)
            except Exception:
                pass
        progress(f"  Google News [{region}] ({len(out)} so far)")
    progress(f"  Google News: {len(out)} articles")
    return out


def collect_reddit(cfg, creds, progress):
    """Free with a Reddit API key (optional)."""
    cid, csec = creds.get("REDDIT_CLIENT_ID"), creds.get("REDDIT_CLIENT_SECRET")
    if not (cid and csec):
        progress("  Reddit: skipped (no key — optional)")
        return []
    try:
        import praw
    except ImportError:
        progress("  Reddit: skipped (praw not installed)")
        return []
    out, markets = [], list(cfg["regions"])
    try:
        reddit = praw.Reddit(client_id=cid, client_secret=csec,
                             user_agent=creds.get("REDDIT_USER_AGENT", "brewscope/1.0"), check_for_async=False)
        reddit.read_only = True
        for sub in ["Coffee", "espresso", "cafe", "barista"]:
            try:
                for post in reddit.subreddit(sub).new(limit=80):
                    types, is_launch = classify_types(f"{post.title} {getattr(post, 'selftext', '')}", cfg)
                    if not types:
                        continue
                    sc = sentiment(post.title)
                    out.append({"id": "rd_" + post.id, "title": post.title,
                                "url": f"https://reddit.com{post.permalink}", "channel": "r/" + sub,
                                "published": datetime.fromtimestamp(post.created_utc, tz=timezone.utc).isoformat(),
                                "views": 0, "likes": int(post.score), "comments": int(post.num_comments),
                                "engagement": int(post.score) + 10 * int(post.num_comments),
                                "sentiment": round(sc, 3), "sent": label(sc), "types": types,
                                "regions": markets, "is_launch": is_launch, "source": "reddit"})
            except Exception:
                pass
        progress(f"  Reddit: {len(out)} posts")
    except Exception as e:
        progress(f"  Reddit: failed ({str(e)[:60]})")
    return out


# Representative search query per perception theme (what people *search*, not post).
THEME_QUERIES = {
    "Health & Wellness": "coffee benefits",
    "Side Effects & Concerns": "coffee anxiety",
    "Energy & Productivity": "coffee energy",
    "Taste & Quality": "best coffee",
    "Sustainability & Ethics": "sustainable coffee",
    "Price & Value": "coffee price",
    "Convenience & Ritual": "coffee pods",
    "Culture & Lifestyle": "coffee aesthetic",
}


def _trends_pytrends(progress):
    """Return a configured pytrends client, or None (best-effort, free tier)."""
    try:
        import inspect
        from urllib3.util.retry import Retry
        if "method_whitelist" not in inspect.signature(Retry.__init__).parameters:
            _o = Retry.__init__
            def _p(self, *a, **k):
                if "method_whitelist" in k:
                    k["allowed_methods"] = k.pop("method_whitelist")
                return _o(self, *a, **k)
            Retry.__init__ = _p
        from pytrends.request import TrendReq
        return TrendReq(hl="en-US", tz=0, timeout=(10, 25))
    except Exception:
        progress("  Google Trends: skipped (pytrends not installed)")
        return None


def _trends_fetch(py, terms, label_kind, progress):
    """terms: {label: query}. Returns {label: {interest, growth}} (best-effort)."""
    interest, items = {}, list(terms.items())
    for i in range(0, len(items), 5):
        grp = items[i:i + 5]
        try:
            py.build_payload([q for _, q in grp], timeframe="today 3-m")
            iot = py.interest_over_time()
            if iot is not None and not iot.empty:
                for name, q in grp:
                    if q in iot.columns:
                        s = iot[q].astype(float)
                        recent = s.tail(14).mean()
                        prior = s.iloc[-42:-14].mean() if len(s) > 42 else s.head(14).mean()
                        interest[name] = {"interest": round(float(s.tail(7).mean()), 1),
                                          "growth": round(float((recent - prior) / (prior + 1e-6)), 3)}
            time.sleep(3)
        except Exception as e:
            if "429" in str(e) or "too many" in str(e).lower():
                progress(f"  Google Trends ({label_kind}): rate-limited — partial results kept.")
                break
    progress(f"  Google Trends: {len(interest)} {label_kind} signals")
    return interest


def google_trends_interest(cfg, progress):
    """Free, no key: search-interest per coffee FORMAT and per PERCEPTION THEME.
    Returns (formats, themes); best-effort — formats first so they survive a rate-limit."""
    py = _trends_pytrends(progress)
    if py is None:
        return {}, {}
    formats, themes = {}, {}
    try:
        formats = _trends_fetch(py, {t: kws[0] for t, kws in cfg["coffee_types"].items()}, "format", progress)
        themes = _trends_fetch(py, THEME_QUERIES, "perception", progress)
    except Exception as e:
        progress(f"  Google Trends: failed ({str(e)[:50]})")
    return formats, themes


# --- accumulation store --------------------------------------------------
def _dump_json(path, obj):
    """Atomic write: temp file + rename, so concurrent readers never see a half file."""
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)
    os.replace(tmp, path)


def load_store():
    if os.path.exists(STORE):
        try:
            return json.load(open(STORE, encoding="utf-8"))
        except Exception:
            return {}
    return {}


def merge_into_store(store, new):
    added = 0
    for r in new:
        k = r["id"]
        if k in store:
            old = store[k]
            old["views"] = max(old.get("views", 0), r.get("views", 0))
            old["engagement"] = max(old.get("engagement", 0), r.get("engagement", 0))
            old["regions"] = sorted(set(old.get("regions", [])) | set(r.get("regions", [])))
        else:
            r["first_seen"] = datetime.now(timezone.utc).isoformat()
            store[k] = r
            added += 1
    return added


# --- brand discovery + tagging ------------------------------------------
# Common English / YouTube-title words that look capitalized but are not brands.
COMMON_WORDS = set("""about after again all also always amazing another any around back bad banana before behind best
better big black blue boy bread break breakfast bring buy can change cheap check classic clean clear color come
comparison cool could cream day days dead deal delicious different diy does done down drink easy eat enjoy every
everything explained fact family fast favorite favourite first five flavor flavour food four free fresh full fun
funny game get giant gift girl give going gold good great green guide guys hack hacks half happy hard health healthy
help here high home homemade honest hot hour hours house how huge idea instant its just keto kind know last learn
left less let life like little live long look love low lunch made make making man many master meal method might mind
minute minutes money more morning most much must myth need never new next nice night noon now off office one only open
order other our over own part party people perfect place play plus pov power pretty pure put quick range rank ranked
real really recipe recipes review right roasting routine secret secrets see series shop short shorts should show
simple small smart some special speed start step stop story style sugar super sweet taste tasted tasting tested test
testing thing things think this three time tips today top trend trick tricks true truth try trying ultimate using
versus very vlog vs want watch water way week well what when which white why will worth wow year years yummy your""".split())


def discover_emerging(records, known_names, min_count=3, max_n=20):
    """Surface NEW brand-like names not already in the knowledge base."""
    from collections import defaultdict
    known_norm = [_norm(k) for k in known_names]
    counts, chans = defaultdict(int), defaultdict(set)
    for r in records:
        title, ch = r.get("title", ""), r.get("channel", "")
        for m in re.finditer(r"\b([A-Z][A-Za-z'&]+(?:\s+[A-Z][A-Za-z'&]+){0,2})\b", title):
            phrase = m.group(1).strip()
            words = phrase.split()
            if any(w in BRAND_STOP for w in words):
                continue
            if len(words) == 1:
                w = words[0]
                if (w.isupper() and len(w) <= 4) or w.lower() in COMMON_WORDS \
                        or re.search(r"(ed|ing|ly)$", w.lower()) or len(w) < 3:
                    continue
            elif all(w.lower() in COMMON_WORDS for w in words):
                continue
            pn = _norm(phrase)
            if any(pn == k or pn in k or k in pn for k in known_norm):
                continue  # already a known brand
            counts[phrase] += 1
            chans[phrase].add(ch)
    cands = sorted([b for b in counts if counts[b] >= min_count and len(chans[b]) >= 2],
                   key=lambda b: -counts[b])
    out = []
    for b in cands:
        if any(b != o and b.lower() in o.lower() for o in cands):
            continue
        out.append({"name": b, "count": counts[b], "channels": len(chans[b])})
    return out[:max_n]


def tag_brands(records, brands):
    pats = {b: re.compile(r"\b" + r"\s+".join(re.escape(p) for p in _norm(b).split()) + r"\b") for b in brands}
    for r in records:
        low = _norm(r.get("title", "") + " " + r.get("desc", ""))
        r["brands"] = sorted([b for b, rx in pats.items() if rx.search(low)])


# --- forecasting + impact ------------------------------------------------
def weekly_history(recs, n_weeks=26):
    now = datetime.now(timezone.utc)
    counts = [0] * n_weeks
    for r in recs:
        d = parse_dt(r.get("published"))
        if not d:
            continue
        idx = n_weeks - 1 - (now - d).days // 7
        if 0 <= idx < n_weeks:
            counts[idx] += 1
    return counts


def sarima_forecast(counts, periods):
    try:
        import numpy as np, warnings
        from statsmodels.tsa.statespace.sarimax import SARIMAX
        y = np.array(counts, dtype=float)
        if len(y) < 12 or (y > 0).sum() < 8 or y.sum() < 15:
            return None
        seasonal = (1, 0, 0, 4) if len(y) >= 18 else (0, 0, 0, 0)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            res = SARIMAX(y, order=(1, 1, 1), seasonal_order=seasonal,
                          enforce_stationarity=False, enforce_invertibility=False).fit(disp=False)
            fc = res.get_forecast(periods)
            mean = fc.predicted_mean
            ci = fc.conf_int(alpha=0.2)
        return {"forecast": [max(0, round(float(v), 1)) for v in mean],
                "lower": [max(0, round(float(v), 1)) for v in ci[:, 0]],
                "upper": [max(0, round(float(v), 1)) for v in ci[:, 1]]}
    except Exception:
        return None


def build_forecasts(records, cfg):
    weeks = 26
    periods = cfg.get("forecast_weeks", 8)
    out, raws = {}, {}
    for t in cfg["coffee_types"]:
        recs = [r for r in records if t in r.get("types", [])]
        hist = weekly_history(recs, weeks)
        fc = sarima_forecast(hist, periods)
        recent_avg = sum(hist[-4:]) / 4
        avg_sent = (sum(r["sentiment"] for r in recs) / len(recs)) if recs else 0
        entry = {"history": hist, "recent_avg": round(recent_avg, 1), "avg_sentiment": round(avg_sent, 3),
                 "forecast": None, "impact_score": 0, "impact_label": "n/a", "growth_pct": 0}
        if fc:
            proj_avg = sum(fc["forecast"][:4]) / 4
            growth = (proj_avg - recent_avg) / (recent_avg + 1)
            raw = growth * math.log1p(sum(hist[-4:])) * (1 + max(-0.5, min(0.5, avg_sent)))
            entry.update(fc)
            entry["proj_avg"] = round(proj_avg, 1)
            entry["growth_pct"] = round(100 * growth, 1)
            entry["_raw"] = raw
            raws[t] = raw
        out[t] = entry
    # normalise impact to 0–100 and label
    if raws:
        lo, hi = min(raws.values()), max(raws.values())
        for t, raw in raws.items():
            score = round(100 * (raw - lo) / (hi - lo)) if hi > lo else 50
            out[t]["impact_score"] = score
            g = out[t]["growth_pct"]
            out[t]["impact_label"] = ("High" if g > 25 else "Medium" if g > 5 else "Low" if g > -10 else "Declining")
            out[t].pop("_raw", None)
    return out


# --- summary -------------------------------------------------------------
def build_summary(records, cfg, our_names):
    from collections import Counter
    now = datetime.now(timezone.utc)
    tc, br = Counter(), Counter()
    tr, tp = Counter(), Counter()
    for r in records:
        d = parse_dt(r.get("published"))
        for t in r.get("types", []):
            tc[t] += 1
            if d and (now - d).days <= 30: tr[t] += 1
            elif d and (now - d).days <= 90: tp[t] += 1
        for b in r.get("brands", []):
            br[b] += 1
    top_type = tc.most_common(1)[0][0] if tc else None
    risers = sorted(tc, key=lambda t: (tr.get(t, 0) / 30) - (tp.get(t, 0) / 60), reverse=True)
    top_riser = risers[0] if risers else None
    top_brand = br.most_common(1)[0][0] if br else None
    total_brand = max(sum(br.values()), 1)
    company = cfg.get("company", "Our portfolio")
    port_n = sum(br.get(b, 0) for b in our_names)
    launches = sum(1 for r in records if r.get("is_launch"))

    ins = []
    if top_type: ins.append(f"<b>{top_type}</b> leads the coffee conversation ({tc[top_type]} mentions).")
    if top_riser and top_riser != top_type: ins.append(f"<b>{top_riser}</b> is gaining momentum fastest among formats.")
    if top_brand: ins.append(f"<b>{top_brand}</b> owns the most share of voice (~{round(100*br[top_brand]/total_brand)}%).")
    if port_n:
        led = max(our_names, key=lambda b: br.get(b, 0))
        ins.append(f"<b>{company}</b> holds ~{round(100*port_n/total_brand,1)}% category SoV; <b>{led}</b> leads our brands.")
    else:
        ins.append(f"<b>{company}</b> brands have near-zero presence in current chatter — a clear whitespace.")
    if launches: ins.append(f"<b>{launches}</b> product-launch signals detected — see Launch Radar.")
    headline = f"{top_type or 'Coffee'} dominates; {top_riser or '—'} is rising. {top_brand or '—'} leads share of voice."
    return {"headline": headline, "insights": ins}


# --- process + orchestrate ----------------------------------------------
def process(records, cfg, progress):
    our = cfg.get("our_brands", [])
    our_names = [b["name"] for b in our]
    ref = load_brand_reference()
    ref_names = [b["name"] for b in ref]
    tracked = list(dict.fromkeys([*our_names, *ref_names]))  # portfolio + knowledge base
    brand_markets = {b["name"]: b["markets"] for b in (ref + our)}

    progress(f"Matching {len(tracked)} known brands; discovering emerging ones...")
    tag_brands(records, tracked)
    emerging = discover_emerging(records, tracked)
    progress(f"Tracked {len(tracked)} known brands · {len(emerging)} emerging brand(s) flagged.")

    progress("Classifying coffee perception themes (health, energy, sustainability...)...")
    tag_perception(records)

    progress("Forecasting formats (SARIMA) + impact factor...")
    forecasts = build_forecasts(records, cfg)
    summary = build_summary(records, cfg, our_names)
    light = [{k: v for k, v in r.items() if k != "desc"} for r in records]
    from collections import Counter
    src_counts = Counter(r.get("source", "?") for r in records)
    si, pi = {}, {}
    if os.path.exists(SEARCH_INTEREST):
        try:
            si = json.load(open(SEARCH_INTEREST, encoding="utf-8"))
        except Exception:
            pass
    if os.path.exists(PERCEPTION_INTEREST):
        try:
            pi = json.load(open(PERCEPTION_INTEREST, encoding="utf-8"))
        except Exception:
            pass
    return {
        "meta": {"generated": datetime.now(timezone.utc).isoformat(), "regions": cfg["regions"],
                 "region_groups": cfg["region_groups"], "video_count": src_counts.get("youtube", 0),
                 "article_count": len(records) - src_counts.get("youtube", 0), "company": cfg.get("company"),
                 "our_brands": our_names, "our_brand_markets": {b["name"]: b["markets"] for b in our},
                 "brand_markets": brand_markets, "app_name": cfg["app_name"],
                 "forecast_weeks": cfg.get("forecast_weeks", 8), "sources": dict(src_counts)},
        "summary": summary,
        "config": {"coffee_types": list(cfg["coffee_types"].keys()), "brands": tracked,
                   "perception_themes": list(PERCEPTION_THEMES.keys())},
        "forecasts": forecasts,
        "emerging_brands": emerging,
        "search_interest": si,
        "perception_interest": pi,
        "records": light,
    }


def build_dataset(progress=lambda m: None):
    cfg = load_config()
    creds = load_credentials()
    os.makedirs(DATA_DIR, exist_ok=True)
    new = []
    key = creds.get("YOUTUBE_API_KEY")
    if key:
        progress("Collecting YouTube (US / UK / Canada)...")
        new += collect_youtube(cfg, key, progress)
    else:
        progress("No YouTube key — skipping YouTube.")
    progress("Collecting Google News (per market)...")
    new += collect_google_news(cfg, progress)
    progress("Collecting Reddit...")
    new += collect_reddit(cfg, creds, progress)
    progress("Collecting coffee press (RSS)...")
    new += collect_rss(cfg, progress)

    store = load_store()
    before = len(store)
    added = merge_into_store(store, new)
    if not store:
        progress("No data collected and no prior store — nothing to build.")
        return {"empty": True}
    _dump_json(STORE, store)
    progress(f"Store: {before} -> {len(store)} records (+{added} new this sync).")

    progress("Google Trends search interest — formats + perception (best-effort)...")
    gt_formats, gt_themes = google_trends_interest(cfg, progress)
    if gt_formats:
        _dump_json(SEARCH_INTEREST, gt_formats)
    if gt_themes:
        _dump_json(PERCEPTION_INTEREST, gt_themes)

    dataset = process(list(store.values()), cfg, progress)
    _dump_json(DATASET, dataset)
    progress(f"Done. {len(store)} accumulated records.")
    return dataset


def reprocess(progress=lambda m: None):
    """Rebuild dataset from the existing store without hitting any API."""
    cfg = load_config()
    store = load_store()
    if not store:
        progress("Store empty — run a sync first.")
        return {"empty": True}
    dataset = process(list(store.values()), cfg, progress)
    _dump_json(DATASET, dataset)
    progress(f"Reprocessed {len(store)} records.")
    return dataset


if __name__ == "__main__":
    import sys
    (reprocess if "--reprocess" in sys.argv else build_dataset)(print)
