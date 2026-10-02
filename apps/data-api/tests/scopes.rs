// The scope vocabulary agrees with the console's list and with the CHECK that
// 00264 puts on data_api_keys.

mod common;

use data_api::scopes::DATA_API_SCOPES;

/// Every single-quoted string in `s`, in order.
fn quoted(s: &str) -> Vec<String> {
    s.split('\'')
        .skip(1)
        .step_by(2)
        .map(str::to_string)
        .collect()
}

#[test]
fn is_the_same_list_in_the_same_order_as_the_shared_one() {
    let src = common::read_repo_file("packages/shared/src/utils/data-api-key.ts");
    let start = src
        .find("export const DATA_API_SCOPES = [")
        .expect("the shared list");
    let list = &src[start..start + src[start..].find("] as const").expect("its end")];
    assert_eq!(quoted(list), DATA_API_SCOPES);
}

#[test]
fn is_exactly_what_the_newest_vocabulary_check_admits() {
    let sql =
        common::read_repo_file("supabase/migrations/00264_the_data_api_reads_more_scopes.sql");
    let marker = "ADD CONSTRAINT data_api_keys_scope_vocabulary";
    let after = &sql[sql.find(marker).expect("the constraint") + marker.len()..];
    let check = after.trim_start();
    assert!(
        check.starts_with("CHECK (scopes <@ ARRAY["),
        "{}",
        &check[..40.min(check.len())]
    );
    let array = &check["CHECK (scopes <@ ARRAY[".len()..];
    let array = &array[..array.find(']').expect("the array's end")];
    assert_eq!(quoted(array), DATA_API_SCOPES);
}
