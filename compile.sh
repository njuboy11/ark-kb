#!/usr/bin/env python3
"""ark-kb compile wrapper — the ONLY way to modify .js files.

All .js files are locked with chattr +i (immutable, even root can't write).
This script temporarily unlocks them, runs tsc, then relocks.
"""
import subprocess, os, sys

PKG_DIR = '/root/.openclaw/npm/ark-kb'

def unlock_js():
    for root, dirs, files in os.walk(PKG_DIR):
        for f in files:
            if f.endswith('.js') and 'node_modules' not in root:
                subprocess.run(['chattr', '-i', os.path.join(root, f)], capture_output=True)

def lock_js():
    for root, dirs, files in os.walk(PKG_DIR):
        for f in files:
            if f.endswith('.js') and 'node_modules' not in root:
                subprocess.run(['chattr', '+i', os.path.join(root, f)], capture_output=True)

def main():
    unlock_js()
    result = subprocess.run(['npx', 'tsc'] + sys.argv[1:], cwd=PKG_DIR)
    if result.returncode == 0:
        # Copy UI files to dist
        os.makedirs(os.path.join(PKG_DIR, 'web', 'ui'), exist_ok=True)
        src_ui = os.path.join(PKG_DIR, 'src', 'web', 'ui', 'index.html')
        dst_ui = os.path.join(PKG_DIR, 'web', 'ui', 'index.html')
        if os.path.exists(src_ui):
            import shutil
            shutil.copy2(src_ui, dst_ui)
    lock_js()
    sys.exit(result.returncode)

if __name__ == '__main__':
    main()
