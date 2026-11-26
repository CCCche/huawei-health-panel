import java.io.File
import java.util.Properties
import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.file.RegularFileProperty
import org.gradle.api.provider.Property
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.InputFile
import org.gradle.api.tasks.OutputDirectory
import org.gradle.api.tasks.PathSensitive
import org.gradle.api.tasks.PathSensitivity
import org.gradle.api.tasks.TaskAction

plugins {
    id("com.android.application") version "9.4.1"
    id("com.chaquo.python") version "17.2.0"
}

abstract class CompileKeyRecoverNativeTask : DefaultTask() {
    @get:InputFile
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val sourceFile: RegularFileProperty

    @get:Input
    abstract val clangPath: Property<String>

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    @TaskAction
    fun compile() {
        val src = sourceFile.get().asFile
        val clang = clangPath.get()
        if (!File(clang).canExecute()) {
            throw GradleException("NDK clang compiler not executable: $clang")
        }
        val abiDir = outputDir.get().dir("arm64-v8a").asFile
        abiDir.mkdirs()
        val outBin = File(abiDir, "libhwh_keyrecover.so")

        val process = ProcessBuilder(
            clang,
            "-O2",
            "-s",
            "-Wall",
            "-Wextra",
            "-Werror",
            "-std=c11",
            "-fPIE",
            "-pie",
            "-Wl,-z,max-page-size=16384",
            "-o",
            outBin.absolutePath,
            src.absolutePath,
        )
            .redirectErrorStream(true)
            .start()

        val output = process.inputStream.bufferedReader().readText()
        val exit = process.waitFor()
        if (exit != 0) {
            throw GradleException("Failed to compile native key-recovery helper (exit $exit):\n$output")
        }
    }
}

fun resolveNdkClang(rootDir: File): String {
    val sdkCandidates = buildList {
        System.getenv("ANDROID_HOME")?.takeIf { it.isNotBlank() }?.let { add(File(it)) }
        System.getenv("ANDROID_SDK_ROOT")?.takeIf { it.isNotBlank() }?.let { add(File(it)) }
        val localProps = File(rootDir, "local.properties")
        if (localProps.isFile) {
            val props = Properties()
            localProps.inputStream().use { props.load(it) }
            props.getProperty("sdk.dir")?.takeIf { it.isNotBlank() }?.let { add(File(it)) }
        }
        add(File("/opt/antigem/android-sdk"))
    }

    val ndkCandidates = buildList {
        System.getenv("ANDROID_NDK_HOME")?.takeIf { it.isNotBlank() }?.let { add(File(it)) }
        for (sdk in sdkCandidates) {
            val ndkRoot = File(sdk, "ndk")
            if (ndkRoot.isDirectory) {
                val preferred = File(ndkRoot, "28.2.13676358")
                if (preferred.isDirectory) add(preferred)
                ndkRoot.listFiles()
                    ?.filter { it.isDirectory }
                    ?.sortedByDescending { it.name }
                    ?.forEach { add(it) }
            }
        }
    }

    val hostTags = listOf("linux-x86_64", "linux-aarch64", "darwin-arm64", "darwin-x86_64")
    val compilerNames = listOf("aarch64-linux-android31-clang", "aarch64-linux-android29-clang", "aarch64-linux-android21-clang")
    for (ndk in ndkCandidates) {
        for (host in hostTags) {
            val binDir = File(ndk, "toolchains/llvm/prebuilt/$host/bin")
            if (!binDir.isDirectory) continue
            for (name in compilerNames) {
                val tool = File(binDir, name)
                if (tool.canExecute()) return tool.absolutePath
            }
        }
    }
    throw GradleException("Could not find NDK aarch64-linux-android*-clang compiler")
}

val compileKeyRecoverNative = tasks.register<CompileKeyRecoverNativeTask>("compileKeyRecoverNative") {
    sourceFile.set(layout.projectDirectory.file("src/main/cpp/hwh_keyrecover.c"))
    clangPath.set(providers.provider { resolveNdkClang(rootDir) })
    outputDir.set(layout.buildDirectory.dir("generated/jniLibs/keyrecover"))
}

android {
    namespace = "xyz.orachen.health.panel"
    compileSdk { version = release(37) { minorApiLevel = 1 } }
    defaultConfig {
        applicationId = "xyz.orachen.health.panel"
        minSdk = 31
        targetSdk = 36
        versionCode = 24
        versionName = "1.0.2"
        ndk { abiFilters += "arm64-v8a" }
    }
    packaging {
        jniLibs {
            useLegacyPackaging = true
        }
    }
}

androidComponents {
    onVariants { variant ->
        variant.sources.jniLibs?.addGeneratedSourceDirectory(
            compileKeyRecoverNative,
            CompileKeyRecoverNativeTask::outputDir,
        )
    }
}

chaquopy {
    defaultConfig {
        version = "3.12"
        buildPython("python3")
    }
}

dependencies {
    implementation("androidx.activity:activity:1.13.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20160810")
}
