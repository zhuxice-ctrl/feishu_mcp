plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "__PACKAGE_ID__"
    compileSdk = __COMPILE_SDK__

    defaultConfig {
        applicationId = "__PACKAGE_ID__"
        minSdk = __MIN_SDK__
        targetSdk = __TARGET_SDK__
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}
