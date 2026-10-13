# Exchange Android APK

This Android app is a signed native package that opens the live Exchange site in
an Android WebView. An internet connection is required. Android customers can
download the APK directly from the website without using Google Play.

## Release signing setup

The local build script creates one Android release key on first run and protects
its password with Windows DPAPI for the current Windows account. It stores the
keystore and encrypted password outside the repository under
`%LOCALAPPDATA%\ExchangeAndroidSigning`. Keep this Windows account and key
directory backed up securely: losing the key prevents future APKs from updating
existing installations. Never commit or share the keystore or its password.

The current APK was signed with a newly generated key because the previous
release key was unavailable. Users with the earlier APK must uninstall it
before installing this one. Use this same key for all future builds; if building
through GitHub Actions, update its four Android signing secrets to match this
keystore or later APKs will not update this release.

The automated GitHub Actions workflow uses equivalent repository secrets when
you choose to build there:

- `ANDROID_KEYSTORE_BASE64`: Base64-encoded contents of the release keystore.
- `ANDROID_KEYSTORE_PASSWORD`: Keystore password.
- `ANDROID_KEY_ALIAS`: `exchange`.
- `ANDROID_KEY_PASSWORD`: Key password.

## Build and publish

With Java 17, Android SDK platform 35, and Gradle 8.9 installed, build and sign
the APK from PowerShell:

```powershell
.\android\build-release.ps1
```

The script writes the signed `exchange-android.apk` into the repository root.
Publish that file with the site deployment so Android users can download it
directly from `/exchange-android.apk` without Google Play. Keep the same signing
key for every update. Alternatively, configure the Actions secrets and run
**Actions → Build Android APK → Run workflow** to create a signed APK artifact.

Customers may need to allow their browser to install apps from this source
when Android asks. The APK receives the live website, so web/API changes are
available without rebuilding the package; changes to the native wrapper require
a new APK release.
