#!/usr/bin/env python3
"""Manual check: does a dialog drag its window to the workspace you are on?

Opens a small window, sends it to another workspace, then has it show a dialog
the way an Electron app (VS Code's "Cannot reconnect. Please reload the
window") does: modal, attached to the window, asking for focus with a current
timestamp. Reports where the window ended up and closes everything.

    python3 tests/manual/dialog-pull.py

Exit status 0 = the window stayed on its workspace, 1 = it was dragged over.
Needs python3-gi (GTK 3), wmctrl and xprop; X11 only.
"""

import re
import subprocess
import sys

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("GdkX11", "3.0")
from gi.repository import GdkX11, GLib, Gtk  # noqa: E402

TITLE = "BetterWorkspaces dialog test (closes by itself)"


def cardinal(args):
    out = subprocess.run(["xprop"] + args, capture_output=True, text=True).stdout
    found = re.search(r"=\s*(\d+)", out)
    return int(found.group(1)) if found else None


def desktop_of(widget):
    return cardinal(["-id", str(widget.get_window().get_xid()), "_NET_WM_DESKTOP"])


class Check:
    def __init__(self):
        self.result = 2
        self.here = cardinal(["-root", "_NET_CURRENT_DESKTOP"])
        count = cardinal(["-root", "_NET_NUMBER_OF_DESKTOPS"])
        if self.here is None or not count or count < 2:
            sys.exit("Needs at least two workspaces.")
        self.away = self.here - 1 if self.here > 0 else 1

        self.parent = Gtk.Window(title=TITLE)
        self.parent.set_default_size(460, 120)
        self.parent.set_focus_on_map(False)
        self.parent.add(Gtk.Label(label="Test window. It closes by itself in a few seconds."))
        self.parent.show_all()
        self.dialog = None
        GLib.timeout_add(700, self.send_away)

    def send_away(self):
        xid = hex(self.parent.get_window().get_xid())
        subprocess.run(["wmctrl", "-i", "-r", xid, "-t", str(self.away)])
        GLib.timeout_add(1200, self.show_dialog)
        return False

    def show_dialog(self):
        if desktop_of(self.parent) != self.away:
            print("Could not move the test window to another workspace; nothing checked.")
            return self.finish()
        self.dialog = Gtk.MessageDialog(
            transient_for=self.parent,
            modal=True,
            message_type=Gtk.MessageType.INFO,
            buttons=Gtk.ButtonsType.NONE,
            text="Test dialog. It closes by itself.",
        )
        self.dialog.set_title(TITLE)
        self.dialog.show()
        now = GdkX11.x11_get_server_time(self.dialog.get_window())
        self.dialog.present_with_time(now)
        GLib.timeout_add(1500, self.report)
        return False

    def report(self):
        if cardinal(["-root", "_NET_CURRENT_DESKTOP"]) != self.here:
            print("You switched workspace during the check; run it again and stay put.")
            return self.finish()
        parent_at = desktop_of(self.parent)
        dialog_at = desktop_of(self.dialog)
        where = "window on workspace %s, its dialog on %s (you are on %s, it was sent to %s)" % (
            parent_at,
            dialog_at,
            self.here,
            self.away,
        )
        if parent_at == self.away:
            print("STAYED: " + where)
            self.result = 0
        else:
            print("PULLED: " + where)
            self.result = 1
        return self.finish()

    def finish(self):
        if self.dialog:
            self.dialog.destroy()
        self.parent.destroy()
        Gtk.main_quit()
        return False


check = Check()
Gtk.main()
sys.exit(check.result)
