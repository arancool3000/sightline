// swift-tools-version: 5.9

// Open this folder (Vision.swiftpm) in Xcode 15 or later and press Run with
// your iPhone selected. See README.md one level up for step-by-step help.

import PackageDescription
import AppleProductTypes

let package = Package(
    name: "Vision",
    platforms: [
        .iOS("17.0")
    ],
    products: [
        .iOSApplication(
            name: "Vision",
            targets: ["AppModule"],
            bundleIdentifier: "com.arankeyhan.vision",
            teamIdentifier: "",
            displayVersion: "1.0",
            bundleVersion: "1",
            appIcon: .asset("AppIcon"),
            accentColor: .asset("AccentColor"),
            supportedDeviceFamilies: [
                .phone
            ],
            supportedInterfaceOrientations: [
                .landscapeRight,
                .landscapeLeft
            ],
            capabilities: [
                .camera(purposeString: "Vision shows your room and tracks your hands so you can touch windows in the air."),
                .locationWhenInUse(purposeString: "Weather uses your location for the local forecast."),
                .photoLibrary(purposeString: "Photos shows your whole library floating in your room, and lets you stand inside your panoramas.")
            ],
            appCategory: .utilities
        )
    ],
    targets: [
        .executableTarget(
            name: "AppModule",
            path: "."
        )
    ]
)
