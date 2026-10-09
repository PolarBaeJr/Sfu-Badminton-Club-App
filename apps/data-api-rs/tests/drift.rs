// The documentation page, the changelog and API.md against the code: every
// route, scope and query parameter is named in the page and API.md, none of
// the three carries an em dash, both pages keep to what their CSP allows (one
// <style> block, no style attribute, no script), and the version is the
// TypeScript service's.

mod common;

use data_api_rs::changelog_page::CHANGELOG_HTML;
use data_api_rs::docs_page::DOCS_HTML;
use data_api_rs::params::QUERY_PARAMS;
use data_api_rs::scopes::DATA_API_SCOPES;
use data_api_rs::server::ROUTES;

fn api_md() -> String {
    common::read_repo_file("apps/data-api/API.md")
}

#[test]
fn the_docs_page_and_api_md_name_every_route_scope_and_parameter() {
    let md = api_md();
    let names = ROUTES
        .iter()
        .map(|r| r.template)
        .chain(DATA_API_SCOPES)
        .chain(QUERY_PARAMS.iter().map(|(n, _)| *n));
    for n in names {
        assert!(DOCS_HTML.contains(n), "docs page: {n}");
        assert!(md.contains(n), "API.md: {n}");
    }
}

#[test]
fn has_no_em_dash_in_the_docs_page_the_changelog_or_api_md() {
    assert!(!DOCS_HTML.contains('\u{2014}'));
    assert!(!CHANGELOG_HTML.contains('\u{2014}'));
    assert!(!api_md().contains('\u{2014}'));
}

#[test]
fn both_pages_keep_to_their_one_csp() {
    let docs_style = DOCS_HTML
        .split("<style>")
        .nth(1)
        .and_then(|s| s.split("</style>").next());
    for page in [DOCS_HTML, CHANGELOG_HTML] {
        assert_eq!(page.matches("<style>").count(), 1);
        assert_eq!(page.matches("</style>").count(), 1);
        let lower = page.to_ascii_lowercase();
        assert!(!lower.contains("<script"));
        // `/\sstyle=/`: an attribute, as opposed to the word in prose.
        for (i, _) in lower.match_indices("style=") {
            let before = lower[..i].chars().next_back();
            assert!(
                !before.is_some_and(char::is_whitespace),
                "a style attribute at byte {i}"
            );
        }
        // One stylesheet for both, so one hash in the CSP covers both.
        let style = page
            .split("<style>")
            .nth(1)
            .and_then(|s| s.split("</style>").next());
        assert_eq!(style, docs_style);
    }
    assert!(data_api_rs::docs_page::DOCS_CSP.contains(&format!(
        "style-src '{}'",
        *data_api_rs::docs_page::DOCS_STYLE_HASH
    )));
}

#[test]
fn the_version_is_the_typescript_service_version() {
    let ts: serde_json::Value =
        serde_json::from_str(&common::read_repo_file("apps/data-api/package.json")).unwrap();
    assert_eq!(ts["version"].as_str(), Some(data_api_rs::VERSION.as_str()));
}
