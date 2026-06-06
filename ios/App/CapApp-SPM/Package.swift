// swift-tools-version: 5.9
import PackageDescription

// DO NOT MODIFY THIS FILE - managed by Capacitor CLI commands
let package = Package(
    name: "CapApp-SPM",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "CapApp-SPM",
            targets: ["CapApp-SPM"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.4.0"),
        .package(name: "CapacitorHaptics", path: "../../../node_modules/@capacitor/haptics"),
        .package(name: "CapgoCameraPreview", path: "../../../node_modules/@capgo/camera-preview"),
        .package(name: "CapgoCapacitorNativeAudio", path: "../../../node_modules/@capgo/capacitor-native-audio"),
        .package(name: "CapgoCapacitorNetworkDiagnostics", path: "../../../node_modules/@capgo/capacitor-network-diagnostics"),
        .package(name: "CapgoCapacitorUpdater", path: "../../../node_modules/@capgo/capacitor-updater")
    ],
    targets: [
        .target(
            name: "CapApp-SPM",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "CapacitorHaptics", package: "CapacitorHaptics"),
                .product(name: "CapgoCameraPreview", package: "CapgoCameraPreview"),
                .product(name: "CapgoCapacitorNativeAudio", package: "CapgoCapacitorNativeAudio"),
                .product(name: "CapgoCapacitorNetworkDiagnostics", package: "CapgoCapacitorNetworkDiagnostics"),
                .product(name: "CapgoCapacitorUpdater", package: "CapgoCapacitorUpdater")
            ]
        )
    ]
)
