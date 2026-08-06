import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { Keybindings } from './imports.js';

const MAX_RESULTS = 12;

let palette = null;
let enabled = false;

export function enable() {
    enabled = true;
}

export function disable() {
    enabled = false;
    palette?.close();
    palette = null;
}

export function toggle() {
    if (palette) {
        palette.close();
        return;
    }

    palette = new CommandPalette();
    palette.open();
}

function fuzzyScore(query, text) {
    const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (words.length === 0)
        return 0;

    text = text.toLowerCase();
    let total = 0;
    for (const word of words) {
        let previous = -2;
        let position = 0;
        let score = 0;

        for (const character of word) {
            const match = text.indexOf(character, position);
            if (match === -1)
                return null;

            const boundary = match === 0 || /[\s-]/.test(text[match - 1]);
            score += boundary ? 8 : 1;
            score += match === previous + 1 ? 5 : 0;
            score -= Math.min(match - position, 4);
            previous = match;
            position = match + 1;
        }

        if (text.includes(word))
            score += 30;
        total += score;
    }

    return total;
}

function formatAccelerator(accelerator) {
    const aliases = {
        Above_Tab: '`',
        BackSpace: 'Backspace',
        Page_Down: 'Page Down',
        Page_Up: 'Page Up',
        Return: 'Enter',
        ISO_Left_Tab: 'Tab',
    };
    const parts = accelerator.match(/<[^>]+>|[^<]+/g) ?? [];

    return parts.map(part => {
        const value = part.replace(/[<>]/g, '');
        if (aliases[value])
            return aliases[value];
        if (value.length === 1)
            return value.toUpperCase();
        return value.charAt(0).toUpperCase() + value.slice(1);
    }).join('+');
}

class CommandPalette {
    constructor() {
        this._selectedIndex = 0;
        this._results = [];
        this._rows = [];
        this._grab = null;

        this.actor = new St.Widget({
            style_class: 'paperwm-command-palette-backdrop',
            reactive: true,
            can_focus: true,
        });
        this.actor.set_position(0, 0);
        this.actor.set_size(global.stage.width, global.stage.height);
        this.actor.connect('button-press-event', (_actor, event) => {
            if (event.get_source() === this.actor) {
                this.close();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        this._box = new St.BoxLayout({
            style_class: 'paperwm-command-palette',
            vertical: true,
            width: 640,
        });
        this.actor.add_child(this._box);

        this._entry = new St.Entry({
            style_class: 'search-entry paperwm-command-palette-entry',
            hint_text: 'Type a PaperWM command...',
            can_focus: true,
            x_expand: true,
        });
        this._box.add_child(this._entry);

        this._list = new St.BoxLayout({
            style_class: 'paperwm-command-palette-results',
            vertical: true,
            x_expand: true,
        });
        this._box.add_child(this._list);

        this._footer = new St.Label({
            style_class: 'paperwm-command-palette-footer',
            text: 'Up/Down: navigate   Enter: run   Esc: close',
        });
        this._box.add_child(this._footer);

        this._entry.clutter_text.connect('text-changed', () => this._filter());
        this._entry.clutter_text.connect('key-press-event', this._onKeyPress.bind(this));
    }

    open() {
        Main.uiGroup.add_child(this.actor);
        this._position();
        this._filter();

        this._grab = Main.pushModal(this.actor);
        if (!this._grab) {
            console.error('PaperWM command palette could not acquire a modal grab');
            this.close();
            return;
        }

        this._entry.grab_key_focus();
    }

    close() {
        if (this._grab) {
            try {
                Main.popModal(this._grab);
            } catch (error) {
                console.debug('PaperWM command palette could not release its modal grab', error);
            }
            this._grab = null;
        }
        this.actor?.destroy();
        this.actor = null;
        if (palette === this)
            palette = null;
    }

    _position() {
        const monitor = Main.layoutManager.currentMonitor ?? Main.layoutManager.primaryMonitor;
        const width = Math.min(640, monitor.width - 48);
        this._box.width = width;
        this._box.set_position(
            monitor.x + Math.floor((monitor.width - width) / 2),
            monitor.y + Math.floor(monitor.height * 0.16));
    }

    _filter() {
        const query = this._entry.get_text();
        this._results = Keybindings.getActionEntries()
            .map((entry, index) => ({
                ...entry,
                index,
                score: fuzzyScore(query, `${entry.description} ${entry.name.replace(/-/g, ' ')}`),
            }))
            .filter(entry => entry.score !== null)
            .sort((a, b) => b.score - a.score || a.index - b.index)
            .slice(0, MAX_RESULTS);

        this._selectedIndex = 0;
        this._render();
    }

    _render() {
        this._list.destroy_all_children();
        this._rows = this._results.map((entry, index) => {
            const row = new St.Button({
                style_class: 'paperwm-command-palette-row',
                reactive: true,
                can_focus: false,
                x_expand: true,
                accessible_name: entry.description,
            });
            const content = new St.BoxLayout({ x_expand: true });
            const description = new St.Label({
                style_class: 'paperwm-command-palette-description',
                text: entry.description,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            const shortcut = new St.Label({
                style_class: entry.keybindings.length > 0
                    ? 'paperwm-command-palette-shortcut'
                    : 'paperwm-command-palette-shortcut unbound',
                text: entry.keybindings.length > 0
                    ? entry.keybindings.slice(0, 2).map(formatAccelerator).join(' / ')
                    : 'Unbound',
                y_align: Clutter.ActorAlign.CENTER,
            });

            content.add_child(description);
            content.add_child(shortcut);
            row.set_child(content);
            row.connect('clicked', () => this._activate(index));
            this._list.add_child(row);
            return row;
        });

        if (this._rows.length === 0) {
            this._list.add_child(new St.Label({
                style_class: 'paperwm-command-palette-empty',
                text: 'No matching commands',
            }));
        }
        this._updateSelection();
    }

    _onKeyPress(_actor, event) {
        const key = event.get_key_symbol();
        if (key === Clutter.KEY_Escape) {
            this.close();
            return Clutter.EVENT_STOP;
        }
        if (key === Clutter.KEY_Down) {
            this._moveSelection(1);
            return Clutter.EVENT_STOP;
        }
        if (key === Clutter.KEY_Up) {
            this._moveSelection(-1);
            return Clutter.EVENT_STOP;
        }
        if (key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter) {
            this._activate(this._selectedIndex);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _moveSelection(direction) {
        if (this._rows.length === 0)
            return;
        this._selectedIndex = (this._selectedIndex + direction + this._rows.length) % this._rows.length;
        this._updateSelection();
    }

    _updateSelection() {
        this._rows.forEach((row, index) => {
            if (index === this._selectedIndex)
                row.add_style_pseudo_class('selected');
            else
                row.remove_style_pseudo_class('selected');
        });
    }

    _activate(index) {
        const entry = this._results[index];
        if (!entry)
            return;

        this.close();
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (enabled)
                Keybindings.activateAction(entry.action);
            return GLib.SOURCE_REMOVE;
        });
    }
}
