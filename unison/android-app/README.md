# Unison for Android

A small Android app that opens your Unison server full screen. It is a shell around the web app, so the server still does the syncing.

## Get the APK

The APK is built in the cloud by GitHub Actions, so you do not need Android Studio.

1. Open the **Actions** tab of this repository and choose **Build Android APK**.
2. Choose **Run workflow**. In **Server address** you can type the address of your hosted server to pre-fill it in the app. Leave it empty to type the address in the app instead.
3. When the run finishes, open it and download **unison-debug-apk** from the Artifacts section. It is a zip file with `app-debug.apk` inside.
4. Copy `app-debug.apk` to your Android phone and open it. Android asks you to allow installing from this source. Allow it for the app you opened the file from.

The build also runs on every pull request that changes this folder, so you can download the APK from the pull request's checks.

## Use it

1. Start the Unison server (`npm start` in the `unison` folder), or use the one you host online.
2. Open the app and enter the server address.
   - Same Wi-Fi: the "Other devices" address that the server prints, for example `http://192.168.1.20:3000`.
   - Internet: the https address of your hosted server.
3. Press **Open Unison**, then start or join a room as usual.

To change the address later, press the Back button until the address screen returns.

## Good to know

- The APK is a debug build. It installs on any phone, but it is not meant for the Play Store.
- Sound can stop when the screen turns off or the app goes to the background. Keep the screen on while listening.
- The app has the default Capacitor icon.
- The build needs the web app to be reachable from the phone. A computer on the same Wi-Fi works, and so does any hosting with HTTPS.
