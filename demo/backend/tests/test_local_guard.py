# sam-ui (Apache-2.0). New file, not from SAM 2.
from flask import Flask

import local_guard


def app(allowed):
    a = Flask(__name__)

    @a.route("/graphql", methods=["GET", "POST"])
    def graphql():
        return "ok"

    local_guard.install(a, allowed)
    return a.test_client()


def test_the_apps_own_page_passes():
    c = app("127.0.0.1:5000")
    assert c.post("/graphql", base_url="http://127.0.0.1:5000", headers={"Origin": "http://127.0.0.1:5000"}).status_code == 200
    assert c.get("/graphql", base_url="http://127.0.0.1:5000").status_code == 200  # no Origin: same-origin GET


def test_another_site_is_refused_even_on_the_right_host():
    c = app("127.0.0.1:5000")
    r = c.post("/graphql", base_url="http://127.0.0.1:5000", headers={"Origin": "https://evil.example"})
    assert r.status_code == 403  # a cross-site form post (e.g. a multipart upload)


def test_dns_rebinding_hosts_are_refused():
    c = app("127.0.0.1:5000")
    assert c.get("/graphql", base_url="http://evil.example:5000").status_code == 403
    assert c.get("/graphql", base_url="http://localhost:5000").status_code == 403


def test_no_setting_means_no_guard():
    c = app(None)
    assert c.post("/graphql", base_url="http://anything:1", headers={"Origin": "https://x"}).status_code == 200
