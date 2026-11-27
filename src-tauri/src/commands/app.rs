use serde::Serialize;

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: &'static str,
    pub version: &'static str,
}

pub fn info() -> AppInfo {
    AppInfo { name: crate::APP_NAME, version: crate::APP_VERSION }
}

#[tauri::command]
pub fn app_info() -> AppInfo {
    info()
}

#[cfg(test)]
mod tests {
    #[test]
    fn info_matches_package() {
        let i = super::info();
        assert_eq!(i.name, "Ivily Center");
        assert_eq!(i.version, env!("CARGO_PKG_VERSION"));
    }
}
