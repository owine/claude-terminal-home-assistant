# Image Paste Feature

## Overview

Claude Terminal Prowine now supports pasting and uploading images directly in the web interface! This feature allows you to easily share images with Claude for analysis, OCR, or any other image-related tasks.

## How It Works

The add-on includes a lightweight Node.js image upload service that:
- Runs on port 7680 (the main web interface)
- Embeds the ttyd terminal on port 7681
- Handles image uploads via paste, drag-drop, or button click
- Saves images to `/data/images/` (persistent storage)
- Provides file paths for use with Claude CLI

## Usage Methods

### Method 1: Paste (Keyboard)
1. Copy an image to your clipboard (from screenshot, browser, etc.)
2. Focus on the terminal window
3. Press **Ctrl+V** (or **Cmd+V** on Mac)
4. The image uploads automatically
5. The file path is shown in the status bar
6. Use the path with Claude: `analyze /data/images/pasted-123456.png`

### Method 2: Drag and Drop
1. Drag an image file from your file manager
2. Drop it anywhere on the terminal window
3. The image uploads automatically
4. Use the file path shown in the status bar

### Method 3: Upload Button
1. Click the **📎 Upload Image** button in the top right
2. Select an image file from the file picker
3. The image uploads automatically
4. Use the file path shown in the status bar

## File Storage

- **Location**: `/data/images/`
- **Persistence**: Images are stored in Home Assistant's persistent storage and survive container restarts
- **Naming**: Files are automatically named `pasted-<timestamp>.<ext>`
- **Formats**: Supports JPEG, PNG, GIF, WebP, and SVG
- **Size Limit**: 10MB per file

## Examples

### Analyze an image with Claude
```bash
# After pasting/uploading an image, you'll see a status message like:
# "Uploaded: pasted-1732374829123.png"

# You can then ask Claude to analyze it:
analyze /data/images/pasted-1732374829123.png
```

### OCR (Extract text from image)
```bash
# Upload a screenshot with text and ask:
extract the text from /data/images/pasted-1732374829123.png
```

### Compare images
```bash
# Upload multiple images and compare:
compare /data/images/pasted-123.png and /data/images/pasted-456.png
```

## Architecture

```
┌─────────────────────────────────────────┐
│   Home Assistant Ingress (Port 7680)   │
│                                         │
│  ┌───────────────────────────────────┐ │
│  │  Image Upload Service (Node.js)   │ │
│  │  - Serves HTML interface          │ │
│  │  - Handles uploads via /upload    │ │
│  │  - Saves to /data/images          │ │
│  └───────────────────────────────────┘ │
│                                         │
│  ┌───────────────────────────────────┐ │
│  │  ttyd Terminal (Port 7681)        │ │
│  │  - Embedded in iframe             │ │
│  │  - Full Claude Code CLI           │ │
│  └───────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

## Technical Details

### Dependencies
- **Express** (v4.18.2): Lightweight HTTP server
- **Multer** (v1.4.5): Handles multipart/form-data for uploads
- Both are ARM-compatible and work on Raspberry Pi

### Resource Usage
- **Memory**: ~10-15MB for Node.js service
- **CPU**: Minimal (only active during uploads)
- **Disk**: Images stored in `/data/images/`

### Ports
- **7680**: Image service + web interface (ingress)
- **7681**: ttyd terminal (embedded)

### Security
- Only image files are accepted (MIME type validation)
- 10MB file size limit
- Files stored in isolated `/data/images/` directory
- No execution permissions on uploaded files

## Troubleshooting

### Image not uploading
1. Check the browser console for errors (F12)
2. Verify the file is an image (JPEG, PNG, GIF, WebP, SVG)
3. Ensure the file is under 10MB
4. Check logs: `podman logs <container-id>`

### Can't see uploaded images in terminal
1. List images: `ls -la /data/images/`
2. Verify permissions: `ls -ld /data/images/`
3. Check disk space: `df -h /data`

### Image service not starting
1. Check logs: `/var/log/image-service.log`
2. Verify Node.js is installed: `node --version`
3. Check if port 7680 is available: `netstat -tulpn | grep 7680`

### Paste not working
1. Ensure you're clicking on the page first (to focus it)
2. Check browser clipboard permissions
3. Try using drag-drop or upload button instead

## Browser Compatibility

✅ **Supported**:
- Chrome/Edge 90+
- Firefox 90+
- Safari 14+

⚠️ **Limited Support**:
- Older browsers may not support clipboard API
- Use drag-drop or upload button instead

## Privacy & Storage

- Images are stored locally on your Home Assistant system
- No images are sent to external services (except when you use them with Claude)
- You can manually delete images: `rm /data/images/pasted-*.png`
- Images persist across add-on restarts and updates

## Future Enhancements

Potential features for future versions:
- [ ] Image preview thumbnails
- [ ] Bulk upload support
- [ ] Automatic image compression
- [ ] Integration with Home Assistant media browser
- [ ] Image history/gallery view
- [ ] Support for copying image paths to clipboard

## Changelog

### v1.6.0 (2024-11-23)
- Initial release of image paste feature
- Support for paste, drag-drop, and button upload
- Lightweight Node.js service (~10MB RAM)
- ARM-compatible for Raspberry Pi
- Persistent storage in `/data/images/`
