{
  "name": "__PROJECT_NAME__",
  "version": "1.0.0",
  "productName": "__PRODUCT_NAME__",
  "description": "A locked Electron desktop application.",
  "main": "src/main.js",
  "scripts": {
    "start": "electron .",
    "test": "node --test",
    "package": "electron-builder --dir"
  },
  "dependencies": {
    "electron": "30.0.0"
  },
  "devDependencies": {
    "electron-builder": "24.13.3"
  }
}
