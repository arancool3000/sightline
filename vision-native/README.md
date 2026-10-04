# Vision (native iPhone app)

A visionOS-style spatial computer for iPhone, built on:

- **ARKit world tracking + LiDAR scene mesh.** Windows are anchored in your room. They stay put when you walk around, real objects hide them, and you can stick them to walls and tables.
- **Vision-framework hand tracking**, which runs on the Neural Engine. Each fingertip's distance is read from the **LiDAR depth map**, so your finger has a real 3D position in the room.
- **People occlusion.** Your hand is drawn *in front of* the windows, not behind them.
- **Smooth motion.** One Euro filtered fingertips, and windows that glide (60/120 fps).

## How to use it

| Gesture | What it does |
|---|---|
| Touch a button in the air with your index finger | Tap it (poke through the glass, pull back) |
| Point at a window from afar, then pinch thumb + index | Tap what the white dot is on |
| Pinch the bar under a window and move your hand | Carry the window. Let go near a wall or table and it snaps on |
| Pinch the × next to the bar | Close the window |
| Tap / drag on the screen | Always works too |

### Touch-free

After setup (the permission prompts, and picking any extra folders for Files), you never need to touch the screen:

- **Voice** is always listening, on the iPhone where possible. Say "what can I say" to see the commands, for example "open photos", "go home", "recenter", "night sky", "search for …", "scroll down", "click …", "next", "open 3", "close", "stop listening".
- **Dictation** replaces the keyboard. In Notes, pinch Dictate (or say "take a note"), talk, then say "done". Pinch a text box on a web page and say what to type.
- **The Digital Crown and Control Center** can be pinched: hold your fingertip over them on screen and pinch. Pinch and drag the Crown for immersion.
- **Safari** is a real browser inside a window: pinch links, or use the scroll buttons. Documents, PDFs, text, videos and music all open inside their windows too.

System controls, as on Vision Pro:

- **Digital Crown** (top right): tap for the Home View, hold to recenter everything in front of you, drag up or down to turn immersion in an environment. While you're inside a panorama, a tap leaves it.
- **Control Center** (the chevron at the top): time and battery, Home, Recenter, Hands, **Ultra Wide**, LiDAR Mesh, Environments, and an immersion slider.

Apps on the Home View: Safari, Photos, Files, Notes, Weather, Clock and Calculator. The tab bar on the left of the Home View switches to **Environments** (Night Sky, Sunset Dunes, Mountain Lake, The Moon).

- **Photos** shows your whole library (choose *Allow Full Access*), with tabs for Library, Favorites, Panoramas and Videos. Open a panorama and tap **Immerse** to stand inside it.
- **Files** shows Vision's own folder (also in the Files app under On My iPhone ▸ Vision). Tap **+ Add Folder** to add iCloud Drive or any other folder. Access is remembered.
- **Ultra Wide** (Control Center) uses the 0.5× camera for the widest view. ARKit can only track the room with the main camera, so in this mode the gyroscope turns your view and windows float around you instead of staying pinned to the room. The setting is remembered.

Best on an iPhone with LiDAR (12 Pro / 13 Pro / 14 Pro / 15 Pro / 16 Pro / 17 Pro). It still runs on other iPhones (iOS 17+), but without the mesh and with estimated hand depth.

## Install on your iPhone (free, with Xcode)

You need a Mac with **Xcode 15 or newer** (free from the Mac App Store) and a USB cable or the same Wi‑Fi network.

1. **Open the project.** Double-click `Vision.swiftpm`, or in Xcode use File ▸ Open… and choose the `Vision.swiftpm` folder.
2. **Sign in.** In Xcode ▸ Settings ▸ Accounts, click **+** ▸ Apple ID and sign in with your normal Apple ID. A free account is fine.
3. **Pick your team.** Click **Vision** at the top of the left sidebar, then open the **Signing & Capabilities** tab. Set **Team** to "*Your Name* (Personal Team)".
   - If it says the bundle identifier is taken, change `com.arankeyhan.vision` in `Package.swift` to something unique, e.g. `com.yourname.vision2`.
4. **Connect your iPhone.** Plug it in and unlock it. Tap **Trust** if asked.
5. **Turn on Developer Mode.** On the iPhone, go to Settings ▸ Privacy & Security ▸ **Developer Mode** ▸ On. The phone restarts.
6. **Run the app.**
   1. In Xcode's top bar, choose your iPhone as the run destination.
   2. Press **▶ Run** (⌘R). The first build takes a minute.
7. **Trust the developer.** The first time, iOS refuses to open the app. On the iPhone, go to Settings ▸ General ▸ **VPN & Device Management**, tap your Apple ID, then tap **Trust**. Press Run again.
8. **Allow camera access** (and location, if you want local weather). Hold the phone in landscape and move it slowly for a second so it maps the room.

With a free Apple ID, the app stops opening after **7 days**. Just press Run in Xcode again to renew it.

### If the build fails

Copy the red error text from Xcode's Issue navigator (⌘5) and send it to me. I'll fix it.
