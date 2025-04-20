const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const archiver = require("archiver");
const moment = require("moment-timezone");
const cron = require("node-cron");
const fsExtra = require("fs-extra");
require("dotenv").config();

// === CONFIGURATION ===
const config = {
  containerApp: "ojs_app_journal",
  containerDB: "ojs_db_journal",
  dbUser: "ojs",
  dbPass: "setYourPass",
  dbName: "stimi",
  folderFiles: "/var/www/files",
  folderPublic: "/var/www/html/public",

  backupRoot: path.join(__dirname, "public"),
  ojsBackupPath: path.join(__dirname, "public", "ojs"),
  mongoBackupPath: path.join(__dirname, "public", "siakad"),

  mongoUri: process.env.DB_URI || "mongodb://localhost:27017",
  maxBackupKeep: process.env.PRODUCTION ? parseInt(process.env.BACK_UP_DATA_WITHIN || "30") : 5,
};

// === MAIN BACKUP FUNCTION ===
function runBackup() {
  const timestamp = moment().tz("Asia/Jakarta").format("YYYY-MM-DD_HH-mm-ss");
  console.log(`\n⏳ [${timestamp}] Starting full backup...`);

  // Ensure all necessary directories exist
  [config.backupRoot, config.ojsBackupPath, config.mongoBackupPath].forEach((dir) => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });

  try {
    backupOJS(timestamp, () => {
      backupMongoDB(timestamp, () => {
        console.log("✅ All backup processes completed.\n");
      });
    });
  } catch (error) {
    console.error("❌ Backup process failed:", error.message);
  }
}

// === OJS BACKUP FUNCTIONS ===
function backupOJS(timestamp, callback) {
  const tempFolder = path.join(config.backupRoot, "temp_ojs", `temp_${timestamp}`);
  const zipOutput = path.join(config.ojsBackupPath, `${timestamp}.zip`);

  createSubfolders(tempFolder, ["files", "public", "database"]);

  try {
    copyFromContainer(config.containerApp, config.folderFiles, path.join(tempFolder, "files"));
    copyFromContainer(config.containerApp, config.folderPublic, path.join(tempFolder, "public"));

    backupOJSDatabase(path.join(tempFolder, "database", "database.sql"), () => {
      createZip(tempFolder, zipOutput, () => {
        fsExtra.removeSync(path.join(config.backupRoot, "temp_ojs"));
        console.log("🧹 Cleaning file temp successfully.");
        callback();
      });
    });
  } catch (err) {
    console.error("❌ Error during OJS backup:", err.message);
  }
}

function createSubfolders(base, subfolders) {
  subfolders.forEach((sub) => {
    fs.mkdirSync(path.join(base, sub), { recursive: true });
  });
}

function copyFromContainer(container, source, destination) {
  console.log(`📁 Prepare data: ${container} - ${source}`);
  const result = spawnSync("docker", ["cp", `${container}:${source}/.`, destination]);

  if (result.status !== 0) {
    throw new Error(`Failed to copy ${source}: ${result.stderr.toString()}`);
  }
}

function backupOJSDatabase(outputPath, callback) {
  console.log("🛢 Backing up OJS database...");

  const outStream = fs.createWriteStream(outputPath);
  const dump = spawn("docker", [
    "exec",
    config.containerDB,
    "/usr/bin/mariadb-dump",
    `-u${config.dbUser}`,
    `-p${config.dbPass}`,
    config.dbName,
  ]);

  dump.stdout.pipe(outStream);

  dump.stderr.on("data", (data) => {
    console.error("❌ OJS DB Error:", data.toString());
  });

  dump.on("close", (code) => {
    if (code === 0) {
      console.log("✅ OJS database backup completed.");
      callback();
    } else {
      console.error(`❌ OJS database dump failed with code ${code}`);
    }
  });
}

function createZip(source, output, callback) {
  console.log("🗜 Creating ZIP archive for OJS...");

  const outputStream = fs.createWriteStream(output);
  const archive = archiver("zip", { zlib: { level: 9 } });

  outputStream.on("close", () => {
    console.log(`✅ ZIP created (${archive.pointer()} bytes)`);
    callback();
  });

  archive.on("error", (err) => {
    console.error("❌ ZIP error:", err.message);
  });

  archive.pipe(outputStream);
  archive.directory(source, false);
  archive.finalize();
}

// === MONGODB BACKUP FUNCTION ===
function backupMongoDB(timestamp, callback) {
  const outputFile = path.join(config.mongoBackupPath, `${timestamp}.gzip`);
  console.log("📦 Backing up MongoDB...");

  const dump = spawn("mongodump", [
    `--uri=${config.mongoUri}`,
    `--archive=${outputFile}`,
    "--gzip",
  ]);

  dump.on("close", (code) => {
    if (code === 0) {
      console.log(`✅ MongoDB backup successful: ${path.basename(outputFile)}`);
    } else {
      console.error("❌ MongoDB backup failed.");
    }
    callback();
  });
}

// === CRON JOB (Every 10 Minutes) ===
cron.schedule("*/10 * * * *", () => {
  runBackup();
});

// Initial manual run
runBackup();
