import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {
    Settings, Utils, Tiling, Navigator,
    App, Scratch, LiveAltTab, Topbar
} from './imports.js';

const Seat = Clutter.get_default_backend().get_default_seat();
const display = global.display;

const KEYBINDINGS_KEY = 'org.gnome.shell.extensions.paperwm.keybindings';
const CHORD_TIMEOUT_MS = 2000;
const KEYED_SCRATCH_ACTIONS = new Set([
    'toggle-keyed-scratch-layer',
    'toggle-keyed-scratch',
]);

let keybindSettings, chordSettings;
export function enable(extension) {
    // restore previous keybinds (in case failed to restore last time, e.g. gnome crash etc)
    Settings.updateOverrides();

    keybindSettings = extension.getSettings(KEYBINDINGS_KEY);
    chordSettings = extension.getSettings();
    setupActions(keybindSettings);
    signals.connect(display, 'accelerator-activated', (display, actionId, deviceId, timestamp) => {
        handleAccelerator(display, actionId, deviceId, timestamp);
    });
    Settings.overrideConflicts();
    enableReservedPrefixes();
    actions.filter(action => !action.options.reservedPrefix).forEach(enableAction);
    enableChords();

    signals.connect(chordSettings, `changed::${Settings.CHORD_KEYBINDINGS_KEY}`, () => {
        disableChords();
        Settings.overrideConflicts();
        enableChords();
    });

    let schemas = [...Settings.getConflictSettings(), extension.getSettings(KEYBINDINGS_KEY)];
    schemas.forEach(schema => {
        signals.connect(schema, 'changed', (settings, key) => {
            const numConflicts = Settings.conflictKeyChanged(settings, key);
            if (numConflicts > 0) {
                Main.notifyError(
                    `PaperWM: overriding '${key}' keybind`,
                    `this Gnome Keybind will be restored when PaperWM is disabled`);
            }
            if (settings === keybindSettings)
                queueChordReload(KEYED_SCRATCH_ACTIONS.has(key));
        });
    });
}

export function disable() {
    disableChords();
    disableReservedPrefixes();
    signals.destroy();
    signals = null;
    actions.forEach(disableAction);
    Settings.restoreConflicts();

    keybindSettings = null;
    chordSettings = null;
    actions = null;
    nameMap = null;
    actionIdMap = null;
    keycomboMap = null;
    reservedDisplacedActions.clear();
}

let chordPrefixes = new Map();
let reservedPrefixes = new Map();
let reservedPrefixCombos = new Set();
let activeChord = null;
let chordReloadId = null;
let reloadReservedPrefixes = false;
const reservedDisplacedActions = new Set();
const pendingChordActions = new Set();

export function prepareForDisable() {
    activeChord?.destroy();
    activeChord = null;
    for (const sourceId of pendingChordActions)
        GLib.source_remove(sourceId);
    pendingChordActions.clear();
    Utils.timeout_remove(chordReloadId);
    chordReloadId = null;
    reloadReservedPrefixes = false;
}

function queueChordReload(reloadReserved = false) {
    reloadReservedPrefixes ||= reloadReserved;
    if (chordReloadId)
        return;
    chordReloadId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        chordReloadId = null;
        const reloadReserved = reloadReservedPrefixes;
        reloadReservedPrefixes = false;
        disableChords();
        if (reloadReserved) {
            const reloadActions = actions.filter(action =>
                !action.options.reservedPrefix &&
                (action.options.settings || action.id !== Meta.KeyBindingAction.NONE ||
                    reservedDisplacedActions.has(action)));
            reloadActions.forEach(disableAction);
            disableReservedPrefixes();
            enableReservedPrefixes();
            for (const action of reloadActions) {
                enableAction(action);
                if (action.options.settings || action.id !== Meta.KeyBindingAction.NONE)
                    reservedDisplacedActions.delete(action);
                else
                    reservedDisplacedActions.add(action);
            }
        }
        enableChords();
        return GLib.SOURCE_REMOVE;
    });
}

function enableChords() {
    const configuredPrefixes = new Map();

    for (const chord of Settings.getChordKeybindings(chordSettings)) {
        const action = nameMap[chord.action];
        if (!action || action.options.reservedPrefix)
            continue;

        const prefixCombo = Settings.keystrToKeycombo(chord.prefix);
        const keyCombo = chordEventCombo(chord.key);
        if (prefixCombo === '0|0' || !keyCombo)
            continue;
        if (reservedPrefixCombos.has(prefixCombo)) {
            console.warn(
                `Ignoring chord ${chord.prefix}, ${chord.key} for ${chord.action}; ` +
                'the prefix is reserved for keyed scratch layers');
            continue;
        }

        let prefix = configuredPrefixes.get(prefixCombo);
        if (!prefix) {
            prefix = {
                keystr: chord.prefix,
                actions: new Map(),
            };
            configuredPrefixes.set(prefixCombo, prefix);
        }
        if (prefix.actions.has(keyCombo)) {
            const existing = prefix.actions.get(keyCombo);
            console.warn(
                `Ignoring duplicate chord ${chord.prefix}, ${chord.key} for ${chord.action}; ` +
                `already assigned to ${existing.action.name}`);
            continue;
        }
        prefix.actions.set(keyCombo, { action, keystr: chord.key });
    }

    for (const prefix of configuredPrefixes.values()) {
        const actionId = Utils.grab_accelerator(prefix.keystr);
        if (actionId === Meta.KeyBindingAction.NONE) {
            console.warn(`Could not enable chord prefix ${prefix.keystr}`);
            continue;
        }

        prefix.actionId = actionId;
        prefix.mutterName = Meta.external_binding_name_for_action(actionId);
        chordPrefixes.set(actionId, prefix);
        Main.wm.allowKeybinding(prefix.mutterName, Shell.ActionMode.NORMAL);
    }
}

function disableChords() {
    prepareForDisable();
    for (const actionId of chordPrefixes.keys())
        display.ungrab_accelerator(actionId);
    chordPrefixes.clear();
}

function enableReservedPrefixes() {
    const configuredCombos = new Map();
    for (const action of actions.filter(candidate => candidate.options.reservedPrefix)) {
        for (const keystr of keybindSettings.get_strv(action.name)) {
            const keycombo = Settings.keystrToKeycombo(keystr);
            if (keycombo === '0|0')
                continue;
            if (configuredCombos.has(keycombo)) {
                console.warn(
                    `Ignoring duplicate keyed scratch prefix ${keystr} for ${action.name}; ` +
                    `already assigned to ${configuredCombos.get(keycombo)}`);
                continue;
            }
            configuredCombos.set(keycombo, action.name);
            reservedPrefixCombos.add(keycombo);

            const actionId = Utils.grab_accelerator(keystr);
            if (actionId === Meta.KeyBindingAction.NONE) {
                console.warn(`Could not enable keyed scratch prefix ${keystr}`);
                continue;
            }
            const prefix = {
                actionId,
                action: action.name,
                keystr,
                mutterName: Meta.external_binding_name_for_action(actionId),
            };
            reservedPrefixes.set(actionId, prefix);
            Main.wm.allowKeybinding(prefix.mutterName, Shell.ActionMode.NORMAL);
        }
    }
}

function disableReservedPrefixes() {
    prepareForDisable();
    for (const actionId of reservedPrefixes.keys())
        display.ungrab_accelerator(actionId);
    reservedPrefixes.clear();
    reservedPrefixCombos.clear();
}

function chordEventCombo(keystr) {
    const [ok, keyval, mask] = Settings.accelerator_parse(keystr);
    if (!ok)
        return null;
    return `${keyval}|${devirtualizeMask(mask) & chordModifierMask()}`;
}

function chordModifierMask() {
    return 0xff &
        ~Clutter.ModifierType.LOCK_MASK &
        ~Clutter.ModifierType.MOD2_MASK &
        ~Clutter.ModifierType.MOD5_MASK;
}

function isModifierKey(keysym) {
    return [
        Clutter.KEY_Shift_L, Clutter.KEY_Shift_R,
        Clutter.KEY_Control_L, Clutter.KEY_Control_R,
        Clutter.KEY_Alt_L, Clutter.KEY_Alt_R,
        Clutter.KEY_Meta_L, Clutter.KEY_Meta_R,
        Clutter.KEY_Super_L, Clutter.KEY_Super_R,
        Clutter.KEY_Hyper_L, Clutter.KEY_Hyper_R,
        Clutter.KEY_Caps_Lock, Clutter.KEY_Shift_Lock, Clutter.KEY_Num_Lock,
        Clutter.KEY_Mode_switch, Clutter.KEY_ISO_Lock,
        Clutter.KEY_ISO_Level3_Shift, Clutter.KEY_ISO_Level3_Latch, Clutter.KEY_ISO_Level3_Lock,
        Clutter.KEY_ISO_Level5_Shift, Clutter.KEY_ISO_Level5_Latch, Clutter.KEY_ISO_Level5_Lock,
    ].includes(keysym);
}

function lowerKeysym(keysym) {
    const codepoint = Clutter.keysym_to_unicode(keysym);
    if (!codepoint)
        return keysym;
    const lower = String.fromCodePoint(codepoint).toLowerCase();
    return Clutter.unicode_to_keysym(lower.codePointAt(0));
}

function activateChordAction(action, keystr) {
    const space = Tiling.spaces.selectedSpace;
    const metaWindow = display.focus_window;
    if (!metaWindow && (action.options.mutterFlags & Meta.KeyBindingFlags.PER_WINDOW))
        return;

    const binding = {
        get_name: () => action.mutterName,
        get_mask: () => rawMaskOfKeystr(keystr) & 0xff,
        is_reversed: () => Boolean(action.options.mutterFlags & Meta.KeyBindingFlags.IS_REVERSED),
    };
    if (action.options.opensNavigator) {
        Navigator.preview_navigate(metaWindow, space, { binding });
    } else {
        action.handler(metaWindow, space, { display, binding });
    }
}

class ChordDispatcher {
    constructor(prefix) {
        this._prefix = prefix;
        this._actor = Tiling.spaces.spaceContainer;
        this._wasReactive = this._actor.reactive;
        this._actor.reactive = true;
        this._grab = Main.pushModal(this._actor);
        if (!this._grab) {
            this._actor.reactive = this._wasReactive;
            console.warn(`Could not grab keyboard for chord prefix ${prefix.keystr}`);
            return;
        }

        this._pressId = this._actor.connect('key-press-event', this._onKeyPress.bind(this));
        this._releaseId = this._actor.connect('key-release-event', this._onKeyRelease.bind(this));
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CHORD_TIMEOUT_MS, () => {
            this._timeoutId = null;
            this.destroy();
            return GLib.SOURCE_REMOVE;
        });
    }

    get active() {
        return Boolean(this._grab);
    }

    _onKeyPress(_actor, event) {
        const eventKeysym = event.get_key_symbol();
        if (isModifierKey(eventKeysym))
            return Clutter.EVENT_STOP;

        const keysym = lowerKeysym(eventKeysym);
        if (keysym !== Clutter.KEY_Escape) {
            if (this._prefix.resolve) {
                this._match = this._prefix.resolve(keysym);
            } else {
                const combo = `${keysym}|${event.get_state() & chordModifierMask()}`;
                this._match = this._prefix.actions.get(combo);
            }
        }
        this._finishKeycode = event.get_key_code();
        this._finishOnRelease = true;
        return Clutter.EVENT_STOP;
    }

    _onKeyRelease(_actor, event) {
        if (!this._finishOnRelease || event.get_key_code() !== this._finishKeycode)
            return Clutter.EVENT_STOP;

        const match = this._match;
        this.destroy();
        if (match) {
            const sourceId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                pendingChordActions.delete(sourceId);
                if (match.callback)
                    match.callback();
                else
                    activateChordAction(match.action, match.keystr);
                return GLib.SOURCE_REMOVE;
            });
            pendingChordActions.add(sourceId);
        }
        return Clutter.EVENT_STOP;
    }

    destroy() {
        Utils.timeout_remove(this._timeoutId);
        this._timeoutId = null;
        if (this._pressId) {
            this._actor.disconnect(this._pressId);
            this._pressId = null;
        }
        if (this._releaseId) {
            this._actor.disconnect(this._releaseId);
            this._releaseId = null;
        }
        if (this._grab) {
            try {
                Main.popModal(this._grab);
            } catch (error) {
                console.debug(`Failed to release chord grab: ${error.message}`);
            }
            this._grab = null;
        }
        try {
            if (this._actor)
                this._actor.reactive = this._wasReactive;
        } catch (error) {
            console.debug(`Failed to restore chord input actor: ${error.message}`);
        }
        if (activeChord === this)
            activeChord = null;
    }
}

export function registerPaperAction(actionName, handler, flags) {
    registerAction(
        actionName,
        handler,
        { settings: keybindSettings, mutterFlags: flags, activeInNavigator: true });
}

export function registerNavigatorAction(name, handler) {
    registerAction(
        name,
        handler,
        { settings: keybindSettings, opensNavigator: true });
}

export function registerMinimapAction(name, handler) {
    registerAction(
        name,
        handler,
        {
            settings: keybindSettings,
            opensNavigator: true,
            opensMinimap: true,
            mutterFlags: Meta.KeyBindingFlags.PER_WINDOW,
        }
    );
}


let signals, actions, nameMap, actionIdMap, keycomboMap;
export function setupActions(settings) {
    signals = new Utils.Signals();
    actions = [];
    nameMap = {};     // mutter keybinding action name -> action
    actionIdMap = {}; // actionID   -> action
    keycomboMap = {}; // keycombo   -> action

    /* Initialize keybindings */
    registerAction('live-alt-tab', LiveAltTab.liveAltTab, { settings });
    registerAction('live-alt-tab-backward', LiveAltTab.liveAltTab,
        { settings, mutterFlags: Meta.KeyBindingFlags.IS_REVERSED });

    registerAction('live-alt-tab-scratch', LiveAltTab.liveAltTabScratch, { settings });
    registerAction('live-alt-tab-scratch-backward', LiveAltTab.liveAltTabScratch,
        { settings, mutterFlags: Meta.KeyBindingFlags.IS_REVERSED });

    registerAction('move-monitor-right', () => {
        Tiling.spaces.switchMonitor(Meta.DisplayDirection.RIGHT, true);
    }, { settings });
    registerAction('move-monitor-left', () => {
        Tiling.spaces.switchMonitor(Meta.DisplayDirection.LEFT, true);
    }, { settings });
    registerAction('move-monitor-above', () => {
        Tiling.spaces.switchMonitor(Meta.DisplayDirection.UP, true);
    }, { settings });
    registerAction('move-monitor-below', () => {
        Tiling.spaces.switchMonitor(Meta.DisplayDirection.DOWN, true);
    }, { settings });

    registerAction('switch-monitor-right', () => {
        Tiling.spaces.switchMonitor(Meta.DisplayDirection.RIGHT, false);
    }, { settings });
    registerAction('switch-monitor-left', () => {
        Tiling.spaces.switchMonitor(Meta.DisplayDirection.LEFT, false);
    }, { settings });
    registerAction('switch-monitor-above', () => {
        Tiling.spaces.switchMonitor(Meta.DisplayDirection.UP, false);
    }, { settings });
    registerAction('switch-monitor-below', () => {
        Tiling.spaces.switchMonitor(Meta.DisplayDirection.DOWN, false);
    }, { settings });

    registerAction('move-space-monitor-right', () => {
        Tiling.spaces.moveToMonitor(Meta.DisplayDirection.RIGHT, Meta.DisplayDirection.LEFT);
    }, { settings });
    registerAction('move-space-monitor-left', () => {
        Tiling.spaces.moveToMonitor(Meta.DisplayDirection.LEFT, Meta.DisplayDirection.RIGHT);
    }, { settings });
    registerAction('move-space-monitor-above', () => {
        Tiling.spaces.moveToMonitor(Meta.DisplayDirection.UP, Meta.DisplayDirection.DOWN);
    }, { settings });
    registerAction('move-space-monitor-below', () => {
        Tiling.spaces.moveToMonitor(Meta.DisplayDirection.DOWN, Meta.DisplayDirection.UP);
    }, { settings });

    registerAction('swap-monitor-right', () => {
        Tiling.spaces.swapMonitor(Meta.DisplayDirection.RIGHT, Meta.DisplayDirection.LEFT);
    }, { settings });
    registerAction('swap-monitor-left', () => {
        Tiling.spaces.swapMonitor(Meta.DisplayDirection.LEFT, Meta.DisplayDirection.RIGHT);
    }, { settings });
    registerAction('swap-monitor-above', () => {
        Tiling.spaces.swapMonitor(Meta.DisplayDirection.UP, Meta.DisplayDirection.DOWN);
    }, { settings });
    registerAction('swap-monitor-below', () => {
        Tiling.spaces.swapMonitor(Meta.DisplayDirection.DOWN, Meta.DisplayDirection.UP);
    }, { settings });

    registerNavigatorAction('previous-workspace', Tiling.selectPreviousSpace);
    registerNavigatorAction('previous-workspace-backward', Tiling.selectPreviousSpaceBackwards);

    registerNavigatorAction('move-previous-workspace', Tiling.movePreviousSpace);
    registerNavigatorAction('move-previous-workspace-backward', Tiling.movePreviousSpaceBackwards);

    registerNavigatorAction('switch-down-workspace', (mw, space) => {
        Tiling.selectDownSpace(mw, space, false);
    });
    registerNavigatorAction('switch-up-workspace', (mw, space) => {
        Tiling.selectUpSpace(mw, space, false);
    });
    registerNavigatorAction('switch-down-workspace-from-all-monitors', (mw, space) => {
        Tiling.selectDownSpace(mw, space, true);
    });
    registerNavigatorAction('switch-up-workspace-from-all-monitors', (mw, space) => {
        Tiling.selectUpSpace(mw, space, true);
    });

    registerNavigatorAction('move-down-workspace', Tiling.moveDownSpace);
    registerNavigatorAction('move-up-workspace', Tiling.moveUpSpace);

    registerPaperAction('toggle-top-and-position-bar', (_mw, space) => {
        const value = !space.settings.get_boolean('show-top-bar');
        space.settings.set_boolean('show-top-bar', value);
        space.settings.set_boolean('show-position-bar', value);
    });
    registerPaperAction('toggle-top-bar', (_mw, space) => {
        const value = space.settings.get_boolean('show-top-bar');
        space.settings.set_boolean('show-top-bar', !value);
    });
    registerPaperAction('toggle-position-bar', (_mw, space) => {
        const value = space.settings.get_boolean('show-position-bar');
        space.settings.set_boolean('show-position-bar', !value);
    });

    registerNavigatorAction('take-window', Tiling.takeWindow);

    registerMinimapAction("switch-next", (mw, space) => space.switchLinear(1, false));
    registerMinimapAction("switch-previous", (mw, space) => space.switchLinear(-1, false));
    registerMinimapAction("switch-next-loop", (mw, space) => space.switchLinear(1, true));
    registerMinimapAction("switch-previous-loop", (mw, space) => space.switchLinear(-1, true));

    registerMinimapAction("switch-right", (mw, space) => space.switchRight(false));
    registerMinimapAction("switch-left", (mw, space) => space.switchLeft(false));
    registerMinimapAction("switch-up", (mw, space) => space.switchUp(false));
    registerMinimapAction("switch-down", (mw, space) => space.switchDown(false));

    registerNavigatorAction("drift-left", (mw, space) => space.driftLeft());
    registerNavigatorAction("drift-right", (mw, space) => space.driftRight());

    registerMinimapAction("switch-right-loop", (mw, space) => space.switchRight(true));
    registerMinimapAction("switch-left-loop", (mw, space) => space.switchLeft(true));
    registerMinimapAction("switch-up-loop", (mw, space) => space.switchUp(true));
    registerMinimapAction("switch-down-loop", (mw, space) => space.switchDown(true));

    registerNavigatorAction("switch-up-or-else-workspace", Tiling.switchUpOrElseWorkspace);
    registerNavigatorAction("switch-down-or-else-workspace", Tiling.switchDownOrElseWorkspace);

    registerMinimapAction("switch-first", Tiling.activateFirstWindow);
    registerMinimapAction("switch-second", (mw, space) => Tiling.activateNthWindow(1, space));
    registerMinimapAction("switch-third", (mw, space) => Tiling.activateNthWindow(2, space));
    registerMinimapAction("switch-fourth", (mw, space) => Tiling.activateNthWindow(3, space));
    registerMinimapAction("switch-fifth", (mw, space) => Tiling.activateNthWindow(4, space));
    registerMinimapAction("switch-sixth", (mw, space) => Tiling.activateNthWindow(5, space));
    registerMinimapAction("switch-seventh", (mw, space) => Tiling.activateNthWindow(6, space));
    registerMinimapAction("switch-eighth", (mw, space) => Tiling.activateNthWindow(7, space));
    registerMinimapAction("switch-ninth", (mw, space) => Tiling.activateNthWindow(8, space));
    registerMinimapAction("switch-tenth", (mw, space) => Tiling.activateNthWindow(9, space));
    registerMinimapAction("switch-eleventh", (mw, space) => Tiling.activateNthWindow(10, space));
    registerMinimapAction("switch-last", Tiling.activateLastWindow);

    registerMinimapAction("switch-global-right", (mw, space) => space.switchGlobalRight());
    registerMinimapAction("switch-global-left", (mw, space) => space.switchGlobalLeft());
    registerMinimapAction("switch-global-up", (mw, space) => space.switchGlobalUp());
    registerMinimapAction("switch-global-down", (mw, space) => space.switchGlobalDown());

    registerMinimapAction("move-left",
        (_mw, space) => space.swap(Meta.MotionDirection.LEFT));
    registerMinimapAction("move-right",
        (_mw, space) => space.swap(Meta.MotionDirection.RIGHT));
    registerMinimapAction("move-up",
        (_mw, space) => space.swap(Meta.MotionDirection.UP));
    registerMinimapAction("move-down",
        (_mw, space) => space.swap(Meta.MotionDirection.DOWN));

    registerPaperAction("toggle-scratch-window",
        Scratch.toggleScratchWindow);

    registerPaperAction("toggle-scratch-layer",
        Scratch.toggleScratch);

    registerPaperAction("toggle-scratch",
        Scratch.toggle,
        Meta.KeyBindingFlags.PER_WINDOW);

    registerAction('toggle-keyed-scratch-layer', null,
        { settings, reservedPrefix: 'toggle' });

    registerAction('toggle-keyed-scratch', null,
        {
            settings,
            reservedPrefix: 'attach',
            mutterFlags: Meta.KeyBindingFlags.PER_WINDOW,
        });

    registerPaperAction("activate-window-under-cursor",
        Tiling.activateWindowUnderCursor);

    registerPaperAction("switch-focus-mode",
        Tiling.switchToNextFocusMode);

    registerPaperAction("switch-open-window-position",
        Topbar.switchToNextOpenPositionMode);
    registerPaperAction("open-window-position-right",
        (_mw, _space) => Topbar.setOpenPositionMode(Settings.OpenWindowPositions.RIGHT));
    registerPaperAction("open-window-position-left",
        (_mw, _space) => Topbar.setOpenPositionMode(Settings.OpenWindowPositions.LEFT));
    registerPaperAction("open-window-position-start",
        (_mw, _space) => Topbar.setOpenPositionMode(Settings.OpenWindowPositions.START));
    registerPaperAction("open-window-position-end",
        (_mw, _space) => Topbar.setOpenPositionMode(Settings.OpenWindowPositions.END));
    registerPaperAction("open-window-position-down",
        (_mw, _space) => Topbar.setOpenPositionMode(Settings.OpenWindowPositions.DOWN));
    registerPaperAction("open-window-position-up",
        (_mw, _space) => Topbar.setOpenPositionMode(Settings.OpenWindowPositions.UP));

    registerPaperAction("resize-h-inc",
        Tiling.resizeHInc,
        Meta.KeyBindingFlags.PER_WINDOW);

    registerPaperAction("resize-h-dec",
        Tiling.resizeHDec,
        Meta.KeyBindingFlags.PER_WINDOW);

    registerPaperAction("resize-w-inc",
        Tiling.resizeWInc,
        Meta.KeyBindingFlags.PER_WINDOW);

    registerPaperAction("resize-w-dec",
        Tiling.resizeWDec,
        Meta.KeyBindingFlags.PER_WINDOW);

    registerPaperAction("cycle-width",
        Tiling.cycleWindowWidth,
        Meta.KeyBindingFlags.PER_WINDOW);

    registerPaperAction("cycle-width-backwards",
        Tiling.cycleWindowWidthBackwards,
        Meta.KeyBindingFlags.PER_WINDOW);

    registerPaperAction("cycle-height",
        Tiling.cycleWindowHeight,
        Meta.KeyBindingFlags.PER_WINDOW);

    registerPaperAction("cycle-height-backwards",
        Tiling.cycleWindowHeightBackwards,
        Meta.KeyBindingFlags.PER_WINDOW);

    registerPaperAction("center-horizontally",
        (mw, _space) => Tiling.centerWindow(mw, true, false),
        Meta.KeyBindingFlags.PER_WINDOW);

    registerPaperAction("center-vertically",
        (mw, _space) => Tiling.centerWindow(mw, false, true),
        Meta.KeyBindingFlags.PER_WINDOW);

    registerPaperAction("center",
        (mw, _space) => Tiling.centerWindow(mw, true, true),
        Meta.KeyBindingFlags.PER_WINDOW);

    registerPaperAction('new-window',
        App.duplicateWindow,
        Meta.KeyBindingFlags.PER_WINDOW);

    registerPaperAction('close-window',
        metaWindow => metaWindow.delete(global.get_current_time()),
        Meta.KeyBindingFlags.PER_WINDOW);

    registerPaperAction('slurp-in',
        (mw, _space) => Tiling.slurp(mw),
        Meta.KeyBindingFlags.PER_WINDOW);

    registerPaperAction('barf-out',
        (mw, _space) => Tiling.barf(mw),
        Meta.KeyBindingFlags.PER_WINDOW);

    registerPaperAction('barf-out-active',
        (mw, _space) => Tiling.barf(mw, mw),
        Meta.KeyBindingFlags.PER_WINDOW);

    registerPaperAction('toggle-maximize-width',
        Tiling.toggleMaximizeHorizontally,
        Meta.KeyBindingFlags.PER_WINDOW);

    registerPaperAction('paper-toggle-fullscreen',
        metaWindow => {
            if (metaWindow.fullscreen) {
                metaWindow.unmake_fullscreen();
            }
            else {
                metaWindow.make_fullscreen();
            }
            Tiling.resizeHandler(metaWindow);
        }, Meta.KeyBindingFlags.PER_WINDOW);
}

export function idOf(mutterName) {
    let action = byMutterName(mutterName);
    if (action) {
        return action.id;
    } else {
        return Meta.KeyBindingAction.NONE;
    }
}

export function byMutterName(name) {
    return nameMap[name];
}

export function byId(mutterId) {
    return actionIdMap[mutterId];
}

export function asKeyHandler(actionHandler) {
    if (Utils.version[0] >= 48) {
        return (display, mw, evt, binding) => actionHandler(mw, Tiling.spaces.selectedSpace, { display, binding });
    } else {
        return (display, mw, binding) => actionHandler(mw, Tiling.spaces.selectedSpace, { display, binding });
    }
}

export function impliedOptions(options) {
    options = options = Object.assign({ mutterFlags: Meta.KeyBindingFlags.NONE }, options);

    if (options.opensMinimap)
        options.opensNavigator = true;

    if (options.opensNavigator)
        options.activeInNavigator = true;

    return options;
}

/**
 * handler: function(metaWindow, space, {binding, display, screen}) -> ignored
 * options: {
 *   opensMinimap:      true|false Start navigation and open the minimap
 *   opensNavigator:    true|false Start navigation (eg. Esc will restore selected space and window)
 *   activeInNavigator: true|false Action is available during navigation
 *   ...
 * }
 */
export function registerAction(actionName, handler, options) {
    options = impliedOptions(options);

    const {
        settings,
        opensNavigator,
    } = options;

    let mutterName, keyHandler;
    if (settings) {
        Utils.assert(actionName, "Schema action must have a name");
        mutterName = actionName;
        keyHandler = opensNavigator
            ? asKeyHandler(Navigator.preview_navigate)
            : asKeyHandler(handler);
    } else {
        // actionId, mutterName and keyHandler will be set if/when the action is bound
    }

    const action = {
        id: Meta.KeyBindingAction.NONE,
        name: actionName,
        mutterName,
        keyHandler,
        handler,
        options,
    };

    actions.push(action);
    if (actionName)
        nameMap[actionName] = action;

    return action;
}

/**
 * Bind a key to an action (possibly creating a new action)
 */
export function bindkey(keystr, actionName = null, handler = null, options = {}) {
    Utils.assert(!options.settings,
        "Can only bind schemaless actions - change action's settings instead",
        actionName);

    let action = actionName && actions.find(a => a.name === actionName);
    let keycombo = Settings.keystrToKeycombo(keystr);

    if (!action) {
        action = registerAction(actionName, handler, options);
    } else {
        let boundAction = keycomboMap[keycombo];
        if (boundAction && boundAction !== action) {
            console.debug("Rebinding", keystr, "to", actionName, "from", boundAction?.name);
            reservedDisplacedActions.delete(boundAction);
            disableAction(boundAction);
        }

        reservedDisplacedActions.delete(action);
        disableAction(action);

        action.handler = handler;
        action.options = impliedOptions(options);
    }

    action.keystr = keystr;
    action.keycombo = keycombo;

    if (enableAction(action) === Meta.KeyBindingAction.NONE) {
        if (reservedPrefixCombos.has(keycombo))
            reservedDisplacedActions.add(action);
        // Keybinding failed: try to supply a useful error message
        let message;
        let boundAction = keycomboMap[keycombo];
        if (boundAction) {
            message = `${keystr} already bound to paperwm action: ${boundAction.name}`;
        } else {
            let boundId = getBoundActionId(keystr);
            if (boundId !== Meta.KeyBindingAction.NONE) {
                let builtInAction =
                    Object.entries(Meta.KeyBindingAction).find(([_name, id]) => id === boundId);
                if (builtInAction) {
                    message = `${keystr} already bound to built-in action: ${builtInAction[0]}`;
                } else {
                    message = `${keystr} already bound to unknown action with id: ${boundId}`;
                }
            }
        }

        if (!message) {
            message = "Usually caused by the binding already being taken, but could not identify which action";
        }

        Main.notifyError(
            "PaperWM (user.js): Could not enable keybinding",
            `Tried to bind ${keystr} to ${actionName}\n${message}`);
    }

    return action.id;
}

export function unbindkey(actionIdOrKeystr) {
    let action;
    if (typeof  actionIdOrKeystr === "string") {
        const keycombo = Settings.keystrToKeycombo(actionIdOrKeystr);
        action = keycomboMap[keycombo] ??
            actions.find(candidate => candidate.keycombo === keycombo &&
                reservedDisplacedActions.has(candidate));
    } else {
        action = actionIdMap[actionIdOrKeystr];
    }

    reservedDisplacedActions.delete(action);
    disableAction(action);
}

export function devirtualizeMask(gdkVirtualMask) {
    if (gdkVirtualMask === 0)
        return 0;

    const keymap = Seat.get_keymap();
    // Clutter.Keymap stopped exposing map_virtual_modifiers() in GNOME 46.
    // Clutter events use the same virtual mask bits on those releases.
    if (typeof keymap.map_virtual_modifiers !== 'function')
        return gdkVirtualMask;

    let [success, rawMask] = keymap.map_virtual_modifiers(gdkVirtualMask);
    if (!success)
        throw new Error(`Couldn't devirtualize mask ${gdkVirtualMask}`);
    return rawMask;
}

export function rawMaskOfKeystr(keystr) {
    let [, , mask] = Settings.accelerator_parse(keystr);
    return devirtualizeMask(mask);
}

export function openNavigatorHandler(actionName, keystr) {
    const mask = rawMaskOfKeystr(keystr) & 0xff;

    const binding = {
        get_name: () => actionName,
        get_mask: () => mask,
        is_reversed: () => false,
    };
    return function(display, screen, metaWindow) {
        return Navigator.preview_navigate(
            metaWindow, null, { screen, display, binding });
    };
}

export function getBoundActionId(keystr) {
    let [, keycodes, mask] = Settings.accelerator_parse(keystr);
    if (keycodes.length > 1) {
        throw new Error(`Multiple keycodes ${keycodes} ${keystr}`);
    }
    const rawMask = devirtualizeMask(mask);
    return display.get_keybinding_action(keycodes[0], rawMask);
}

export function handleAccelerator(display, actionId, _deviceId, _timestamp) {
    const reserved = reservedPrefixes.get(actionId);
    const prefix = reserved ? keyedScratchPrefix(reserved) : chordPrefixes.get(actionId);
    if (prefix) {
        activeChord?.destroy();
        const dispatcher = new ChordDispatcher(prefix);
        if (dispatcher.active)
            activeChord = dispatcher;
        return;
    }

    const action = actionIdMap[actionId];
    if (action) {
        console.debug("#keybindings", "Schemaless keybinding activated",
            actionId, action.name);
        action.keyHandler(display, display.focus_window);
    }
}

function keyedScratchPrefix(prefix) {
    const metaWindow = display.focus_window;
    return {
        keystr: prefix.keystr,
        resolve(keysym) {
            const codepoint = Clutter.keysym_to_unicode(keysym);
            if (!codepoint)
                return null;
            const layer = String.fromCodePoint(codepoint).toLowerCase();
            if (!/^[a-z0-9]$/.test(layer))
                return null;

            if (prefix.action === 'toggle-keyed-scratch-layer')
                return { callback: () => Scratch.toggleLayer(layer) };
            if (!metaWindow)
                return null;
            return { callback: () => Scratch.toggleInLayer(metaWindow, layer) };
        },
    };
}

export function disableAction(action) {
    if (action.id === Meta.KeyBindingAction.NONE) {
        return;
    }

    const oldId = action.id;
    if (action.options.settings) {
        Main.wm.removeKeybinding(action.mutterName);
        action.id = Meta.KeyBindingAction.NONE;
        delete actionIdMap[oldId];
    } else {
        display.ungrab_accelerator(action.id);
        action.id = Meta.KeyBindingAction.NONE;

        delete nameMap[action.mutterName];
        delete actionIdMap[oldId];
        delete keycomboMap[action.keycombo];

        action.mutterName = undefined;
    }
}

export function enableAction(action) {
    if (action.id !== Meta.KeyBindingAction.NONE)
        return action.id; // Already enabled (happens on enable right after init)

    if (action.options.settings) {
        let actionId = Main.wm.addKeybinding(
            action.mutterName,
            action.options.settings,
            action.options.mutterFlags || Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL,
            action.keyHandler);

        if (actionId !== Meta.KeyBindingAction.NONE) {
            action.id = actionId;
            actionIdMap[actionId] = action;
        } else {
            console.warn("Could not enable action", action.name);
        }
    } else {
        if (keycomboMap[action.keycombo]) {
            console.warn("Other action bound to", action.keystr, keycomboMap[action.keycombo].name);
            return Meta.KeyBindingAction.NONE;
        }

        let actionId = Utils.grab_accelerator(action.keystr);
        if (actionId === Meta.KeyBindingAction.NONE) {
            console.warn("Failed to grab. Binding probably already taken");
            return Meta.KeyBindingAction.NONE;
        }

        let mutterName = Meta.external_binding_name_for_action(actionId);

        action.id = actionId;
        action.mutterName = mutterName;

        actionIdMap[actionId] = action;
        keycomboMap[action.keycombo] = action;
        nameMap[mutterName] = action;

        if (action.options.opensNavigator) {
            action.keyHandler = openNavigatorHandler(mutterName, action.keystr);
        } else {
            action.keyHandler = asKeyHandler(action.handler);
        }

        Main.wm.allowKeybinding(action.mutterName, Shell.ActionMode.ALL);

        return action.id;
    }
}
