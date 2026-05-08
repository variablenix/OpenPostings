OpenPostings Android build commands

Exact reproducible release APK sequence:

```powershell
cd C:\Users\RKerrigan\Projects\OpenPostings\OpenPostings
npm run prepare:android:backend
cd .\android
.\gradlew.bat --% :app:assembleRelease -x lint -PMYAPP_UPLOAD_STORE_FILE=openpostings-upload-key.jks -PMYAPP_UPLOAD_KEY_ALIAS=openpostingsupload -PMYAPP_UPLOAD_STORE_PASSWORD=OpenPostings2026 -PMYAPP_UPLOAD_KEY_PASSWORD=OpenPostings2026
```

Release APK output:

```text
C:\Users\RKerrigan\Projects\OpenPostings\OpenPostings\android\app\build\outputs\apk\release\app-release.apk
```

Exact reproducible release AAB sequence:

```powershell
cd C:\Users\RKerrigan\Projects\OpenPostings\OpenPostings
npm run prepare:android:backend
cd .\android
.\gradlew.bat --% :app:bundleRelease -x lint -PMYAPP_UPLOAD_STORE_FILE=openpostings-upload-key.jks -PMYAPP_UPLOAD_KEY_ALIAS=openpostingsupload -PMYAPP_UPLOAD_STORE_PASSWORD=OpenPostings2026 -PMYAPP_UPLOAD_KEY_PASSWORD=OpenPostings2026
```

Release AAB output:

```text
C:\Users\RKerrigan\Projects\OpenPostings\OpenPostings\android\app\build\outputs\bundle\release\app-release.aab
```

One-time keystore generation (only if missing):

```powershell
cd C:\Users\RKerrigan\Projects\OpenPostings\OpenPostings
keytool -genkeypair -v -storetype JKS -keystore .\android\app\openpostings-upload-key.jks -alias openpostingsupload -keyalg RSA -keysize 2048 -validity 10000
```

Notes:
- `The NODE_ENV environment variable is required...` is a warning here, not the signing failure.
- If Play says version code already used, bump `versionCode` in `OpenPostings\android\app\build.gradle`.
