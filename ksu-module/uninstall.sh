#!/system/bin/sh

LOG_TAG=pathmask
PERSIST_DIR="/data/adb/pathmask"

log_i() {
	log -p i -t "$LOG_TAG" "$*" 2>/dev/null
}

# Unload the kernel module if it's still in /proc/modules. KernelSU runs this
# script while the module folder is being removed; stop the kernel side first
# so we don't leave a dangling LKM behind.
if grep -q '^pathmask ' /proc/modules 2>/dev/null; then
	if rmmod pathmask 2>/dev/null; then
		log_i "rmmod pathmask succeeded"
	else
		log_i "rmmod pathmask failed; module will unload on next reboot"
	fi
fi

# Unload the procguard companion module if this build shipped one.
if grep -q '^procguard ' /proc/modules 2>/dev/null; then
	if rmmod procguard 2>/dev/null; then
		log_i "rmmod procguard succeeded"
	else
		log_i "rmmod procguard failed; module will unload on next reboot"
	fi
fi

# Drop the persistent config directory so a future fresh install starts from
# the zip-bundled defaults instead of inheriting stale UID lists, fail
# counters, boot_state, etc.
if [ -d "$PERSIST_DIR" ]; then
	rm -rf "$PERSIST_DIR" 2>/dev/null && \
		log_i "removed $PERSIST_DIR"
fi
