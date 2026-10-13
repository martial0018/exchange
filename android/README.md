# Exchange Android APK

This Android app is a signed native package that opens the live Exchange site in
an Android WebView. An internet connection is required. Android customers can
download the APK directly from the website without using Google Play.

## Release signing setup

Keep the Android release keystore private and backed up. Losing it prevents
future APK versions from updating existing installations. Never commit the
keystore or its passwords.

Generate a key on a trusted machine with Java's `keytool`:

```powershell
keytool -genkeypair -v -keystore exchange-release.jks -alias exchange -keyalg RSA -keysize 2048 -validity 10000
```

Add these repository Actions secrets under **Settings → Secrets and variables
→ Actions**:

- `ANDROID_KEYSTORE_BASE64`: Base64-encoded contents of `exchange-release.jks`.
- `ANDROID_KEYSTORE_PASSWORD`: Keystore password.
- `ANDROID_KEY_ALIAS`: `exchange` (or the alias selected above).
- `ANDROID_KEY_PASSWORD`: Key password.

On Windows PowerShell, copy the encoded keystore to the clipboard without
printing it to the terminal:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes(".\exchange-release.jks")) | Set-Clipboard
```

Paste that value directly into the `ANDROID_KEYSTORE_BASE64` secret field. Do
not send the keystore or passwords in chat or commit them to the repository.

## Build and publish

Run **Actions → Build Android APK → Run workflow** to build a signed APK
artifact. To create a public direct-download release, push a tag such as
`android-v1.0.0`. The workflow attaches `exchange-android.apk` to the GitHub
release; the website's Android download button points to the latest release.

Customers may need to allow their browser to install apps from this source
when Android asks. The APK receives the live website, so web/API changes are
available without rebuilding the package; changes to the native wrapper require
a new APK release.
