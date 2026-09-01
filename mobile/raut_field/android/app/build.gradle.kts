import java.util.Properties
import java.io.FileInputStream

// Signing material is read from android/key.properties, which is gitignored.
// When it is absent — a fresh clone, or CI without the secret — release builds
// fall back to the debug key so `flutter run --release` still works locally.
// A build that would ship must never do that silently, so the fallback is
// announced loudly at configure time.
val keystoreProperties = Properties()
val keystorePropertiesFile = rootProject.file("key.properties")
val hasReleaseSigning = keystorePropertiesFile.exists()
if (hasReleaseSigning) {
    keystoreProperties.load(FileInputStream(keystorePropertiesFile))
}

plugins {
    id("com.android.application")
    id("kotlin-android")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

android {
    namespace = "com.raut.app"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }

    kotlinOptions {
        jvmTarget = JavaVersion.VERSION_11.toString()
    }

    // The Sunmi printer is reached over AIDL. The interface is declared in
    // src/main/aidl rather than pulled from a vendor jar, so the build has no
    // binary dependency we cannot check into the repository.
    buildFeatures {
        aidl = true
    }

    defaultConfig {
        applicationId = "com.raut.app"
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = file(keystoreProperties["storeFile"] as String)
                storePassword = keystoreProperties["storePassword"] as String
                keyAlias = keystoreProperties["keyAlias"] as String
                keyPassword = keystoreProperties["keyPassword"] as String
            }
        }
    }

    buildTypes {
        release {
            signingConfig = if (hasReleaseSigning) {
                signingConfigs.getByName("release")
            } else {
                logger.warn(
                    "RAUT: android/key.properties is missing — signing this release " +
                    "with the DEBUG key. The artifact cannot be uploaded to Play."
                )
                signingConfigs.getByName("debug")
            }

            // R8 shrinks and obfuscates. Flutter ships the keep rules its
            // engine needs, so this is safe without a custom proguard file.
            isMinifyEnabled = true
            isShrinkResources = true
        }
    }
}

flutter {
    source = "../.."
}
