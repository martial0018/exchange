$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$toolRoot = Join-Path $env:LOCALAPPDATA 'ExchangeAndroidBuild'
$signingRoot = Join-Path $env:LOCALAPPDATA 'ExchangeAndroidSigning'
$jdkDirectory = Get-ChildItem -LiteralPath $toolRoot -Directory -Filter 'jdk-*' -ErrorAction SilentlyContinue | Select-Object -First 1
$gradleExecutable = Join-Path $toolRoot 'gradle-8.9\bin\gradle.bat'
$sdkRoot = Join-Path $toolRoot 'sdk'
$sdkManager = Join-Path $sdkRoot 'cmdline-tools\latest\bin\sdkmanager.bat'
$keytool = if ($jdkDirectory) { Join-Path $jdkDirectory.FullName 'bin\keytool.exe' }
$keystore = Join-Path $signingRoot 'exchange-release.jks'
$encryptedPasswordFile = Join-Path $signingRoot 'exchange-release-password.dpapi'
$versionCodeFile = Join-Path $signingRoot 'version-code.txt'

if (-not $jdkDirectory -or -not (Test-Path -LiteralPath $keytool)) {
    throw "Java 17 is missing. Install it under $toolRoot before building."
}
if (-not (Test-Path -LiteralPath $gradleExecutable)) {
    throw "Gradle 8.9 is missing. Install it under $toolRoot before building."
}
if (-not (Test-Path -LiteralPath $sdkManager)) {
    throw "Android command-line tools are missing. Install them under $sdkRoot before building."
}

$env:JAVA_HOME = $jdkDirectory.FullName
$env:ANDROID_HOME = $sdkRoot
$env:ANDROID_SDK_ROOT = $sdkRoot
$env:PATH = "$env:JAVA_HOME\bin;$sdkRoot\platform-tools;$env:PATH"

New-Item -ItemType Directory -Force -Path $signingRoot | Out-Null
if (-not (Test-Path -LiteralPath $keystore) -and (Test-Path -LiteralPath $encryptedPasswordFile)) {
    throw "The signing password exists but its keystore is missing at $keystore. Restore the original keystore backup."
}
if ((Test-Path -LiteralPath $keystore) -and -not (Test-Path -LiteralPath $encryptedPasswordFile)) {
    throw "The release keystore exists but its protected password file is missing. Restore both signing files from backup."
}

if (-not (Test-Path -LiteralPath $keystore)) {
    $randomBytes = New-Object byte[] 36
    $randomGenerator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $randomGenerator.GetBytes($randomBytes)
    } finally {
        $randomGenerator.Dispose()
    }
    $password = [Convert]::ToBase64String($randomBytes).TrimEnd('=')
    $securePassword = ConvertTo-SecureString -String $password -AsPlainText -Force
    $securePassword | ConvertFrom-SecureString | Set-Content -LiteralPath $encryptedPasswordFile
    $password = $null
    $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
    try {
        $env:ANDROID_KEYSTORE_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
    }
    $env:ANDROID_KEY_PASSWORD = $env:ANDROID_KEYSTORE_PASSWORD
    & $keytool -genkeypair -v -keystore $keystore -storetype JKS -alias exchange `
        -keyalg RSA -keysize 2048 -validity 10000 `
        -dname 'CN=Exchange App, O=Exchange, C=US' `
        -storepass:env ANDROID_KEYSTORE_PASSWORD -keypass:env ANDROID_KEY_PASSWORD
    if ($LASTEXITCODE -ne 0) {
        Remove-Item -LiteralPath $encryptedPasswordFile -Force -ErrorAction SilentlyContinue
        throw 'Could not create the local Android release signing key.'
    }
    Write-Output 'Created a private release key outside the repository and protected its password with Windows DPAPI.'
} else {
    $encryptedPassword = [IO.File]::ReadAllText($encryptedPasswordFile).Trim()
    $securePassword = ConvertTo-SecureString -String $encryptedPassword
    $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
    try {
        $env:ANDROID_KEYSTORE_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
    }
    $env:ANDROID_KEY_PASSWORD = $env:ANDROID_KEYSTORE_PASSWORD
}

$versionCode = 1
if (Test-Path -LiteralPath $versionCodeFile) {
    $previousVersionCode = 0
    if (-not [int]::TryParse((Get-Content -LiteralPath $versionCodeFile -Raw).Trim(), [ref]$previousVersionCode)) {
        throw "The saved Android version code is invalid: $versionCodeFile"
    }
    $versionCode = $previousVersionCode + 1
}
$env:ANDROID_VERSION_CODE = [string]$versionCode
$env:ANDROID_VERSION_NAME = "1.0.$versionCode"
$env:ANDROID_KEYSTORE_PATH = $keystore
$env:ANDROID_KEY_ALIAS = 'exchange'

try {
    1..50 | ForEach-Object { 'y' } | & $sdkManager "--sdk_root=$sdkRoot" --licenses
    if ($LASTEXITCODE -ne 0) {
        throw 'Could not accept Android SDK licenses for the current build.'
    }
    & $sdkManager "--sdk_root=$sdkRoot" 'platforms;android-35' 'build-tools;35.0.0'
    if ($LASTEXITCODE -ne 0) {
        throw 'Could not install the Android API 35 build platform.'
    }
    & $gradleExecutable --no-daemon --stacktrace -p (Join-Path $repositoryRoot 'android') assembleRelease
    if ($LASTEXITCODE -ne 0) {
        throw 'Gradle could not build the signed Android release APK.'
    }

    $apk = Join-Path $repositoryRoot 'android\app\build\outputs\apk\release\app-release.apk'
    $publishedApk = Join-Path $repositoryRoot 'exchange-android.apk'
    $apksigner = Join-Path $sdkRoot 'build-tools\35.0.0\apksigner.bat'
    if (-not (Test-Path -LiteralPath $apk)) {
        throw "The Android build did not produce the expected APK: $apk"
    }
    & $apksigner verify --verbose $apk
    if ($LASTEXITCODE -ne 0) {
        throw 'The generated APK did not pass Android signature verification.'
    }
    Copy-Item -LiteralPath $apk -Destination $publishedApk -Force
    Set-Content -LiteralPath $versionCodeFile -Value $versionCode -NoNewline
    Write-Output "Built signed Exchange Android APK version $($env:ANDROID_VERSION_NAME): $publishedApk"
} finally {
    Remove-Item Env:ANDROID_KEYSTORE_PASSWORD -ErrorAction SilentlyContinue
    Remove-Item Env:ANDROID_KEY_PASSWORD -ErrorAction SilentlyContinue
    Remove-Item Env:ANDROID_KEYSTORE_PATH -ErrorAction SilentlyContinue
    Remove-Item Env:ANDROID_KEY_ALIAS -ErrorAction SilentlyContinue
}
