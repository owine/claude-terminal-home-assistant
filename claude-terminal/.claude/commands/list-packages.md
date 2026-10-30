# List Installed Packages

Show all packages installed with the persistent package manager.

## Usage
- `/list-packages` - Show all persistent packages

## What You Should Do

1. **Run the list command**: `persist-install --list`
2. **Show the output**: Display what packages are installed
3. **Explain the structure**:
   - System packages are recorded in `/data/packages/world` and reinstalled by apk on every start
   - Python packages in `/data/packages/python/venv`
   - All packages persist across reboots

## Example Output

You'll see:
- The recorded system packages
- List of Python packages (from venv)
- The size of apk's download cache

## Additional Info

If user wants to see:
- **System packages only**: `cat /data/packages/world`
- **Python packages only**: `source /data/packages/python/venv/bin/activate && pip list`
- **Disk usage**: `du -sh /data/packages`
