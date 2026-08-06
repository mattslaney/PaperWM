import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as WindowMenu from 'resource:///org/gnome/shell/ui/windowMenu.js';

import { Settings, Utils, Tiling, Topbar } from './imports.js';
import { Easer } from './utils.js';

let originalBuildMenu;
const scratchLayer = Symbol.for('paperwm.scratch-layer');
const scratchFrame = Symbol.for('paperwm.scratch-frame');
const DEFAULT_LAYER = '0';
const CHORD_TIMEOUT_MS = 2000;

let chord, operationIdleId;
export function enable() {
    originalBuildMenu = WindowMenu.WindowMenu.prototype._buildMenu;
    WindowMenu.WindowMenu.prototype._buildMenu =
        function (window) {
            let item;
            const layer = getScratchLayer(window);
            const label = layer ? `${_('Scratch')} (${layer.toUpperCase()})` : _('Scratch');
            item = this.addAction(label, () => {
                toggle(window);
            });
            if (isScratchWindow(window))
                item.setOrnament(PopupMenu.Ornament.CHECK);

            originalBuildMenu.call(this, window);
        };
}

export function disable() {
    chord?.close();
    chord = null;
    Utils.timeout_remove(operationIdleId);
    operationIdleId = null;
    WindowMenu.WindowMenu.prototype._buildMenu = originalBuildMenu;
    originalBuildMenu = null;
}

/**
   Tween window to "frame-coordinate" (targetX, targetY).
   The frame is moved once the tween is done.

   The actual window actor (not clone) is tweened to ensure it's on top of the
   other windows/clones (clones if the space animates)
 */
export function easeScratch(metaWindow, targetX, targetY, params = {}) {
    const complete = params?.onComplete ?? function() {};
    const f = metaWindow.get_frame_rect();
    const b = metaWindow.get_buffer_rect();
    const dx = f.x - b.x;
    const dy = f.y - b.y;

    Easer.addEase(metaWindow.get_compositor_private(), {
        x: targetX - dx,
        y: targetY - dy,
        time: Settings.prefs.animation_time,
        onComplete: () => {
            metaWindow.move_frame(true, targetX, targetY);
            complete();
        },
    });
}

export function makeScratch(metaWindow, layer = null) {
    const currentLayer = getScratchLayer(metaWindow);
    let fromNonScratch = !currentLayer;
    let fromTiling = false;
    // Relevant when called while navigating. Use the position the user actually sees.
    let windowPositionSeen;

    if (fromNonScratch) {
        // Figure out some stuff before the window is removed from the tiling
        let space = Tiling.spaces.spaceOfWindow(metaWindow);
        fromTiling = space.indexOf(metaWindow) > -1;
        if (fromTiling) {
            windowPositionSeen = metaWindow.clone
                .get_transformed_position()
                .map(Math.round);
        }
    }

    metaWindow[scratchLayer] = normalizeLayer(layer) ?? currentLayer ?? DEFAULT_LAYER;
    metaWindow.make_above();
    metaWindow.stick();  // NB! Removes the window from the tiling (synchronously)

    if (!metaWindow.minimized)
        Tiling.showWindow(metaWindow);

    if (fromTiling) {
        let f = metaWindow.get_frame_rect();
        let targetFrame = null;

        if (metaWindow[scratchFrame]) {
            let sf = metaWindow[scratchFrame];
            if (Utils.monitorOfPoint(sf.x, sf.y) === Tiling.focusMonitor()) {
                targetFrame = sf;
            }
        }

        if (!targetFrame) {
            // Default to moving the window slightly down and reducing the height
            let vDisplacement = 30;
            let [x, y] = windowPositionSeen;  // The window could be non-placable so can't use frame

            targetFrame = new Mtk.Rectangle({
                x, y: y + vDisplacement,
                width: f.width,
                height: Math.min(f.height - vDisplacement, Math.floor(f.height * 0.9)),
            });
        }

        if (!metaWindow.minimized) {
            metaWindow.move_resize_frame(true, f.x, f.y,
                targetFrame.width, targetFrame.height);
            easeScratch(
                metaWindow,
                targetFrame.x,
                targetFrame.y,
                {
                    onComplete: () => {
                        delete metaWindow[scratchFrame];
                        Main.activateWindow(metaWindow);
                    },
                });
        } else {
            // Can't restore the scratch geometry immediately since it distort the minimize animation
            // ASSUMPTION: minimize animation is not disabled and not already done
            let actor = metaWindow.get_compositor_private();
            let signal = actor.connect('effects-completed', () => {
                metaWindow.move_resize_frame(true, targetFrame.x, targetFrame.y,
                    targetFrame.width, targetFrame.height);
                actor.disconnect(signal);
            });
        }
    }

    Tiling.focusMonitor()?.clickOverlay?.hide();
}

export function unmakeScratch(metaWindow) {
    if (!metaWindow[scratchFrame])
        metaWindow[scratchFrame] = metaWindow.get_frame_rect();
    metaWindow[scratchLayer] = null;
    metaWindow.unmake_above();
    metaWindow.unstick();
}

export function toggle(metaWindow) {
    if (isScratchWindow(metaWindow)) {
        unmakeScratch(metaWindow);
    } else {
        makeScratch(metaWindow);

        if (metaWindow.has_focus) {
            let space = Tiling.spaces.activeSpace;
            space.setSelectionInactive();
        }
    }
}

export function toggleInLayer(metaWindow, layer) {
    if (!metaWindow)
        return;

    layer = normalizeLayer(layer);
    if (getScratchLayer(metaWindow) === layer) {
        unmakeScratch(metaWindow);
    } else {
        const fromNonScratch = !isScratchWindow(metaWindow);
        makeScratch(metaWindow, layer);
        if (fromNonScratch && metaWindow.has_focus)
            Tiling.spaces.activeSpace.setSelectionInactive();
    }
}

export function getScratchLayer(metaWindow) {
    return metaWindow?.[scratchLayer] ?? null;
}

export function isScratchWindow(metaWindow) {
    return getScratchLayer(metaWindow) !== null;
}

/** Return scratch windows in MRU order */
export function getScratchWindows(layer = null) {
    layer = normalizeLayer(layer);
    return global.display.get_tab_list(Meta.TabList.NORMAL, null)
        .filter(metaWindow => isScratchWindow(metaWindow) &&
            (layer === null || getScratchLayer(metaWindow) === layer));
}

export function isScratchActive() {
    return getScratchWindows().some(metaWindow => !metaWindow.minimized);
}

export function toggleScratch() {
    if (isScratchActive())
        hide();
    else
        show();
}

export function toggleScratchWindow() {
    let focus = global.display.focus_window;
    if (isScratchWindow(focus))
        hide();
    else
        show(true);
}

export function show(top) {
    showScratchWindows(getScratchWindows(), top);
}

export function hide() {
    hideScratchWindows(getScratchWindows());
}

function toggleLayer(layer) {
    const windows = getScratchWindows(layer);
    if (windows.some(metaWindow => !metaWindow.minimized))
        hideScratchWindows(windows);
    else
        showScratchWindows(windows);
}

function toggleWindowInLayer(layer) {
    const metaWindow = getScratchWindows(layer)[0];
    if (!metaWindow)
        return;

    if (!metaWindow.minimized && global.display.focus_window === metaWindow)
        metaWindow.minimize();
    else
        showScratchWindows([metaWindow]);
}

function showScratchWindows(windows, top = false) {
    if (windows.length === 0) {
        return;
    }
    if (top)
        windows = windows.slice(0, 1);

    Topbar.fixTopBar();

    windows.slice().reverse()
        .map(function(meta_window) {
            meta_window.unminimize();
            meta_window.make_above();
            meta_window.get_compositor_private().show();
        });
    windows[0].activate(global.get_current_time());

    Tiling.focusMonitor()?.clickOverlay?.hide();
}

function hideScratchWindows(windows) {
    windows.map(function(meta_window) {
        meta_window.minimize();
    });
}

export function animateWindows() {
    let ws = getScratchWindows().filter(w => !w.minimized);
    ws = global.display.sort_windows_by_stacking(ws);
    for (let w of ws) {
        // let parent = w.clone.get_parent();
        // parent && parent.remove_child(w.clone);
        Utils.actor_remove_parent(w.clone);

        Main.uiGroup.insert_child_above(w.clone, global.window_group);
        let f = w.get_frame_rect();
        w.clone.set_position(f.x, f.y);
        Tiling.animateWindow(w);
    }
}

export function showWindows() {
    let ws = getScratchWindows().filter(w => !w.minimized);
    ws.forEach(Tiling.showWindow);
}

export function beginScratchWindowChord() {
    beginChord('window');
}

export function beginScratchLayerChord() {
    beginChord('layer');
}

export function beginScratchAttachChord(metaWindow) {
    beginChord('attach', metaWindow);
}

function normalizeLayer(layer) {
    if (layer === null || layer === undefined)
        return null;
    return String(layer).toLowerCase();
}

function beginChord(operation, metaWindow = null) {
    chord?.close();
    chord = new ScratchChord(operation, metaWindow);
    chord.open();
}

function layerFromEvent(event) {
    const key = event.get_key_symbol();
    const modifiers = [
        Clutter.KEY_Alt_L, Clutter.KEY_Alt_R,
        Clutter.KEY_Control_L, Clutter.KEY_Control_R,
        Clutter.KEY_Meta_L, Clutter.KEY_Meta_R,
        Clutter.KEY_Shift_L, Clutter.KEY_Shift_R,
        Clutter.KEY_Super_L, Clutter.KEY_Super_R,
    ];
    if (modifiers.includes(key))
        return undefined;

    const codepoint = Clutter.keysym_to_unicode(key);
    if (!codepoint)
        return null;
    const layer = String.fromCodePoint(codepoint).toLowerCase();
    return /^[a-z0-9]$/.test(layer) ? layer : null;
}

function layerSummary() {
    const tracker = Shell.WindowTracker.get_default();
    const layers = new Map();
    for (const metaWindow of getScratchWindows()) {
        const layer = getScratchLayer(metaWindow);
        const app = tracker.get_window_app(metaWindow);
        const label = app?.get_name() ?? metaWindow.get_title();
        if (!layers.has(layer))
            layers.set(layer, []);
        if (!layers.get(layer).includes(label))
            layers.get(layer).push(label);
    }

    return [...layers.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([layer, labels]) => `${layer.toUpperCase()}  ${labels.slice(0, 3).join(', ')}`)
        .join('\n');
}

class ScratchChord {
    constructor(operation, metaWindow) {
        this.operation = operation;
        this.metaWindow = metaWindow;
        this.grab = null;
        this.timeoutId = null;

        this.actor = new St.Widget({ reactive: true, can_focus: true });
        this.actor.set_position(0, 0);
        this.actor.set_size(global.stage.width, global.stage.height);
        this.actor.connect('key-press-event', this._onKeyPress.bind(this));
        this.actor.connect('button-press-event', () => {
            this.close();
            return Clutter.EVENT_STOP;
        });

        if (Settings.prefs.show_scratch_chord_hint) {
            const titles = {
                window: 'Toggle recent scratch window',
                layer: 'Toggle scratch layer',
                attach: 'Attach/detach focused window',
            };
            const summary = layerSummary();
            const text = `${titles[operation]}\nPress a layer key (A-Z or 0-9)` +
                (summary ? `\n\n${summary}` : '\n\nNo occupied layers');
            this.hint = new St.Label({
                style_class: 'scratch-chord-hint',
                text,
                width: 440,
            });
            this.actor.add_child(this.hint);
        }
    }

    open() {
        Main.uiGroup.add_child(this.actor);
        if (this.hint) {
            const monitor = Main.layoutManager.currentMonitor ?? Main.layoutManager.primaryMonitor;
            this.hint.set_position(
                monitor.x + Math.floor((monitor.width - this.hint.width) / 2),
                monitor.y + Math.floor(monitor.height * 0.16));
        }

        this.grab = Main.pushModal(this.actor);
        if (!this.grab) {
            console.error('PaperWM scratch chord could not acquire a modal grab');
            this.close();
            return;
        }
        this.actor.grab_key_focus();
        this.timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CHORD_TIMEOUT_MS, () => {
            this.timeoutId = null;
            this.close();
            return GLib.SOURCE_REMOVE;
        });
    }

    close() {
        Utils.timeout_remove(this.timeoutId);
        this.timeoutId = null;
        if (this.grab) {
            try {
                Main.popModal(this.grab);
            } catch (error) {
                console.debug('PaperWM scratch chord could not release its modal grab', error);
            }
            this.grab = null;
        }
        this.actor?.destroy();
        this.actor = null;
        if (chord === this)
            chord = null;
    }

    _onKeyPress(_actor, event) {
        if (event.get_key_symbol() === Clutter.KEY_Escape) {
            this.close();
            return Clutter.EVENT_STOP;
        }

        const layer = layerFromEvent(event);
        if (layer === undefined)
            return Clutter.EVENT_STOP;
        if (layer === null) {
            this.close();
            return Clutter.EVENT_STOP;
        }

        const operation = this.operation;
        const metaWindow = this.metaWindow;
        this.close();
        Utils.timeout_remove(operationIdleId);
        operationIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (operation === 'window')
                toggleWindowInLayer(layer);
            else if (operation === 'layer')
                toggleLayer(layer);
            else
                toggleInLayer(metaWindow, layer);
            operationIdleId = null;
            return GLib.SOURCE_REMOVE;
        });
        return Clutter.EVENT_STOP;
    }
}
