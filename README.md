# Photo Mirror desktop app 1.0.0

Send photos and files from your phone straight to your computer. No account, no website to host.

Developed by Seun Ajetomobi. support@helekt.net

## How it works
The app runs a small server on your computer and shows the viewer in its own window.
Open **Setup**, scan the QR code with your phone camera, and the phone page opens.
Take a photo, pick one from the gallery, or send a file, and it appears on the shelf.
The phone and the computer must be on the same Wi-Fi. Photos stay in a folder on your computer.

## First run
- **Windows:** SmartScreen says "Windows protected your PC" (the app is not code-signed). Click *More info*, then *Run anyway*. Windows Firewall asks to allow Photo Mirror on private networks. Allow it, or the phone cannot connect.
- **macOS:** open the .dmg, drag Photo Mirror to Applications. The first time, right-click the app, choose *Open*, then *Open* again. On the first run macOS asks to allow incoming connections. Allow it.
- **Linux:** `chmod +x Photo-Mirror-*.AppImage` and run it, or install the .deb with `sudo apt install ./Photo-Mirror-*.deb`.

## Text from photos (OCR)
The desktop app reads text with the Tesseract program, which must be installed on the computer
(Windows: tesseract-ocr installer; macOS: `brew install tesseract`; Linux: `sudo apt install tesseract-ocr`).
Without it everything else works, only the text-reading pane is unavailable.

## Build the installers
GitHub repository, Actions tab, *Build desktop apps*, *Run workflow*. After about 10 minutes download
`photo-mirror-windows-latest`, `photo-mirror-macos-latest` and `photo-mirror-ubuntu-latest` from the run.
For permanent download links create a Release with a tag such as `v1.0.0`; the files are attached to it.
If the `.github` folder did not upload, create `.github/workflows/build.yml` by hand and paste the contents of `BUILD-WORKFLOW.yml`.
