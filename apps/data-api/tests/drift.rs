// The documentation page and API.md against the code: every route, scope and
// query parameter is named in both, neither carries an em dash, and the page
// keeps to what its CSP allows (one <style> block, no style attribute, no
// script).

mod common;

use data_api::docs_page::DOCS_HTML;
use data_api::params::QUERY_PARAMS;
use data_api::scopes::DATA_API_SCOPES;
use data_api::server::ROUTES;

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
fn has_no_em_dash_in_the_docs_page_or_api_md() {
    assert!(!DOCS_HTML.contains('\u{2014}'));
    assert!(!api_md().contains('\u{2014}'));
}

#[test]
fn the_docs_page_keeps_to_its_csp() {
    assert_eq!(DOCS_HTML.matches("<style>").count(), 1);
    assert_eq!(DOCS_HTML.matches("</style>").count(), 1);
    let lower = DOCS_HTML.to_ascii_lowercase();
    assert!(!lower.contains("<script"));
    // `/\sstyle=/`: an attribute, as opposed to the word in prose.
    for (i, _) in lower.match_indices("style=") {
        let before = lower[..i].chars().next_back();
        assert!(
            !before.is_some_and(char::is_whitespace),
            "a style attribute at byte {i}"
        );
    }
    assert!(data_api::docs_page::DOCS_CSP.contains(&format!(
        "style-src '{}'",
        *data_api::docs_page::DOCS_STYLE_HASH
    )));
}
