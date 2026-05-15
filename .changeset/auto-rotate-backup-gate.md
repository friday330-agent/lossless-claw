---
"@martian-engineering/lossless-claw": patch
---

Disable SQLite backups during automatic session-file rotation by default. Set `autoRotateSessionFiles.createBackups` to `true` to keep automatic runtime and startup rotation creating the rolling `rotate-latest` backup; manual `/lcm rotate` still creates that backup by default.
