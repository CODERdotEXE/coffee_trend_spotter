"""
Brewscope web app — Flask backend.

Routes:
  GET  /                 -> dashboard (templates/index.html)
  GET  /api/data         -> latest dataset.json (or empty state)
  POST /api/sync         -> start a background sync (pull fresh videos)
  GET  /api/sync/status  -> live progress of the running/last sync
"""

import os
import json
import threading
from datetime import datetime

from flask import Flask, jsonify, render_template, request, Response

import collector

HERE = os.path.dirname(os.path.abspath(__file__))
app = Flask(__name__, static_folder="static", template_folder="templates")

SYNC = {"running": False, "progress": [], "done": False, "error": None, "started": None}
_lock = threading.Lock()

# Optional shared-password gate. Set BREWSCOPE_PASSWORD to require login (recommended
# for any public URL — this is internal data). Unset = open (local/dev).
PASSWORD = os.environ.get("BREWSCOPE_PASSWORD")
USERNAME = os.environ.get("BREWSCOPE_USER", "team")


@app.before_request
def _require_login():
    if not PASSWORD:
        return
    a = request.authorization
    if not a or a.username != USERNAME or a.password != PASSWORD:
        return Response("Login required", 401, {"WWW-Authenticate": 'Basic realm="Brewscope"'})


def _run_sync():
    SYNC.update(running=True, progress=[], done=False, error=None, started=datetime.now().isoformat())

    def progress(msg):
        SYNC["progress"].append(msg)

    try:
        collector.build_dataset(progress)
    except Exception as e:
        SYNC["error"] = str(e)
        progress(f"ERROR: {e}")
    finally:
        SYNC["running"] = False
        SYNC["done"] = True


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/data")
def api_data():
    if os.path.exists(collector.DATASET):
        with open(collector.DATASET, encoding="utf-8") as f:
            return app.response_class(f.read(), mimetype="application/json")
    return jsonify({"empty": True})


@app.route("/api/sync", methods=["POST"])
def api_sync():
    with _lock:
        if SYNC["running"]:
            return jsonify({"started": False, "message": "Sync already running"})
        threading.Thread(target=_run_sync, daemon=True).start()
    return jsonify({"started": True})


@app.route("/api/sync/status")
def api_sync_status():
    return jsonify(SYNC)


@app.route("/favicon.ico")
def favicon():
    return ("", 204)


if __name__ == "__main__":
    host = os.environ.get("HOST", "127.0.0.1")   # set HOST=0.0.0.0 when deploying
    port = int(os.environ.get("PORT", "5000"))   # most hosts inject PORT
    auth = "on" if PASSWORD else "OFF (set BREWSCOPE_PASSWORD to lock down)"
    try:
        from waitress import serve  # production WSGI: one process, many threads
        print(f"\n  Brewscope (production) at http://{host}:{port}   auth: {auth}\n")
        serve(app, host=host, port=port, threads=8)
    except ImportError:
        print(f"\n  Brewscope (dev) at http://{host}:{port}   auth: {auth}\n")
        app.run(host=host, port=port, debug=False, threaded=True)
