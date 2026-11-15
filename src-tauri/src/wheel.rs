//! macOS: make physical mouse-wheel clicks scroll like Chromium (VS Code).
//!
//! For a mouse wheel (not a trackpad), WebKit computes the scroll from `NSEvent.deltaY`, which
//! macOS accelerates into fractional "lines" (a slow click can arrive as 0.1 of a line), so slow
//! clicks barely move. Chromium instead reads the whole-number line count
//! (`kCGScrollWheelEventDeltaAxis1`), so every click moves at least one full step.
//!
//! A local event monitor sees each scroll event before WebKit does. For mouse-wheel events only
//! (`hasPreciseScrollingDeltas == NO`), it swaps the fractional line delta for Chromium's whole
//! number (at least one per click). Trackpad and Magic Mouse events (precise) pass untouched.

use block2::RcBlock;
use objc2::encode::{Encoding, RefEncode};
use objc2::msg_send;
use objc2::runtime::{AnyClass, AnyObject};
use std::ffi::c_void;

/// Opaque CGEvent, typed so message sends match `NSEvent.CGEvent`'s `^{__CGEvent=}`.
#[repr(C)]
pub struct CGEvent {
    _private: [u8; 0],
}
unsafe impl RefEncode for CGEvent {
    const ENCODING_REF: Encoding = Encoding::Pointer(&Encoding::Struct("__CGEvent", &[]));
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventCreateCopy(event: *mut CGEvent) -> *mut CGEvent;
    fn CGEventGetIntegerValueField(event: *mut CGEvent, field: u32) -> i64;
    fn CGEventGetDoubleValueField(event: *mut CGEvent, field: u32) -> f64;
    fn CGEventSetDoubleValueField(event: *mut CGEvent, field: u32, value: f64);
}
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(cf: *const c_void);
}

// CGEventField values (CGEventTypes.h).
const DELTA_AXIS_1: u32 = 11; // whole lines, vertical (what Chromium reads)
const DELTA_AXIS_2: u32 = 12; // whole lines, horizontal
const IS_CONTINUOUS: u32 = 88; // 1 = precise (trackpad)
const FIXED_PT_DELTA_AXIS_1: u32 = 93; // fractional lines, vertical (what NSEvent.deltaY reports)
const FIXED_PT_DELTA_AXIS_2: u32 = 94;
const NS_EVENT_MASK_SCROLL_WHEEL: u64 = 1 << 22;

/// Chromium's whole-number step: the integer line count, or at least ±1 when macOS
/// accelerated a click below one line.
fn whole_lines(fractional: f64, integer: i64) -> f64 {
    if integer != 0 {
        integer as f64
    } else if fractional > 0.0 {
        1.0
    } else if fractional < 0.0 {
        -1.0
    } else {
        0.0
    }
}

/// The rewrite itself: mouse-wheel events get whole-line deltas, everything else passes as is.
///
/// # Safety
/// `event` must be null or a valid NSEvent.
unsafe fn chromium_like(event: *mut AnyObject) -> *mut AnyObject {
    if event.is_null() {
        return event;
    }
    let precise: bool = msg_send![event, hasPreciseScrollingDeltas];
    if precise {
        return event; // trackpad / Magic Mouse: leave as is
    }
    let cg: *mut CGEvent = msg_send![event, CGEvent];
    if cg.is_null() || CGEventGetIntegerValueField(cg, IS_CONTINUOUS) != 0 {
        return event;
    }
    let fy = CGEventGetDoubleValueField(cg, FIXED_PT_DELTA_AXIS_1);
    let fx = CGEventGetDoubleValueField(cg, FIXED_PT_DELTA_AXIS_2);
    let wy = whole_lines(fy, CGEventGetIntegerValueField(cg, DELTA_AXIS_1));
    let wx = whole_lines(fx, CGEventGetIntegerValueField(cg, DELTA_AXIS_2));
    if wy == fy && wx == fx {
        return event; // already whole lines
    }
    let copy = CGEventCreateCopy(cg);
    if copy.is_null() {
        return event;
    }
    CGEventSetDoubleValueField(copy, FIXED_PT_DELTA_AXIS_1, wy);
    CGEventSetDoubleValueField(copy, FIXED_PT_DELTA_AXIS_2, wx);
    let Some(cls) = AnyClass::get(c"NSEvent") else {
        CFRelease(copy as *const c_void);
        return event;
    };
    let replaced: *mut AnyObject = msg_send![cls, eventWithCGEvent: copy];
    CFRelease(copy as *const c_void);
    if replaced.is_null() {
        event
    } else {
        replaced
    }
}

/// Installs the monitor for the app's lifetime. Call once, on the main thread.
pub fn install_chromium_wheel() {
    let handler = RcBlock::new(|event: *mut AnyObject| -> *mut AnyObject { unsafe { chromium_like(event) } });
    unsafe {
        let Some(cls) = AnyClass::get(c"NSEvent") else { return };
        let monitor: *mut AnyObject = msg_send![cls, addLocalMonitorForEventsMatchingMask: NS_EVENT_MASK_SCROLL_WHEEL, handler: &*handler];
        if !monitor.is_null() {
            // The monitor (and its block) must live as long as the app.
            let _: *mut AnyObject = msg_send![monitor, retain];
            std::mem::forget(handler);
            eprintln!("slate: mouse wheel clicks scroll in whole steps, like Chromium");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventCreateScrollWheelEvent2(source: *mut c_void, units: u32, count: u32, w1: i32, w2: i32, w3: i32) -> *mut CGEvent;
        fn CGEventSetIntegerValueField(event: *mut CGEvent, field: u32, value: i64);
    }
    const LINE_UNITS: u32 = 1;

    /// A scroll event as macOS delivers it: `continuous` = trackpad, `lines` = accelerated value.
    unsafe fn ns_event(continuous: bool, whole: i64, lines: f64) -> *mut AnyObject {
        let cg = CGEventCreateScrollWheelEvent2(std::ptr::null_mut(), LINE_UNITS, 1, whole as i32, 0, 0);
        CGEventSetIntegerValueField(cg, IS_CONTINUOUS, continuous as i64);
        CGEventSetIntegerValueField(cg, DELTA_AXIS_1, whole);
        CGEventSetDoubleValueField(cg, FIXED_PT_DELTA_AXIS_1, lines);
        let cls = AnyClass::get(c"NSEvent").unwrap();
        let ev: *mut AnyObject = msg_send![cls, eventWithCGEvent: cg];
        CFRelease(cg as *const c_void);
        ev
    }

    unsafe fn delta_y(ev: *mut AnyObject) -> f64 {
        msg_send![ev, deltaY]
    }

    #[test]
    fn slow_wheel_click_becomes_a_whole_line_like_chromium() {
        unsafe {
            let ev = ns_event(false, -1, -0.37);
            let before = delta_y(ev);
            let after = delta_y(chromium_like(ev));
            println!("mouse wheel, slow click: NSEvent.deltaY {before:.2} -> {after:.2}");
            assert!((before - -0.37).abs() < 0.01, "test event should start fractional");
            assert_eq!(after, -1.0);
        }
    }

    #[test]
    fn click_below_one_line_still_moves_one_line() {
        unsafe {
            let after = delta_y(chromium_like(ns_event(false, 0, 0.1)));
            println!("mouse wheel, integer 0 / 0.1 line: deltaY -> {after:.2}");
            assert_eq!(after, 1.0);
        }
    }

    #[test]
    fn fast_spin_keeps_its_size() {
        unsafe {
            let after = delta_y(chromium_like(ns_event(false, -6, -5.8)));
            println!("mouse wheel, fast spin (6 lines): deltaY -> {after:.2}");
            assert_eq!(after, -6.0);
        }
    }

    #[test]
    fn trackpad_events_pass_through_untouched() {
        unsafe {
            let ev = ns_event(true, 0, -0.37);
            let out = chromium_like(ev);
            println!("trackpad: same event object = {}", out == ev);
            assert_eq!(out, ev);
        }
    }
}
