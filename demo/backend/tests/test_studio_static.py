# sam-ui (Apache-2.0). New file, not from SAM 2.
import pytest
from flask import Flask

from studio_static import make_studio_blueprint


@pytest.fixture
def client(tmp_path):
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<html>studio</html>")
    (dist / "assets" / "app.js").write_text("console.log(1)")
    (tmp_path / "secret.txt").write_text("nope")
    app = Flask(__name__)

    @app.route("/graphql", methods=["POST", "GET"])
    def graphql():
        return "api"

    @app.route("/gallery/<path:path>")
    def gallery(path):
        return f"gallery {path}"

    app.register_blueprint(make_studio_blueprint(str(dist)))
    return app.test_client()


def test_index_and_assets_are_served(client):
    r = client.get("/")
    assert r.status_code == 200 and b"studio" in r.data and r.headers["Cache-Control"] == "no-cache"
    assert client.get("/assets/app.js").data == b"console.log(1)"


def test_api_routes_win_over_the_catch_all(client):
    assert client.get("/graphql").data == b"api"
    assert client.get("/gallery/01_dog.mp4").data == b"gallery 01_dog.mp4"


def test_missing_files_and_escapes_are_404(client):
    assert client.get("/nope.js").status_code == 404
    assert client.get("/../secret.txt").status_code == 404
    assert client.get("/assets/../../secret.txt").status_code == 404


def test_a_dist_without_index_html_is_refused(tmp_path):
    with pytest.raises(FileNotFoundError, match="build studio first"):
        make_studio_blueprint(str(tmp_path))
