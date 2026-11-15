//! Integrated terminals: each one is your shell in a pseudo-terminal (portable-pty, the same
//! library herdr uses). Output streams to the window over a channel; keystrokes come back via
//! `term_write`. Every shell is killed when Slate quits.

use crate::err;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;
use tauri::State;

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    shell_pid: Option<u32>,
}

impl Session {
    /// Ends the shell *and* whatever runs in it (an agent, a dev server, `sleep`...): hang up
    /// the terminal's foreground process group and the shell's own group, then force-kill
    /// anything still alive a second later. Signalling only the shell would leave the
    /// foreground program running.
    fn terminate(mut self) {
        #[cfg(unix)]
        {
            let mut groups: Vec<libc::pid_t> = Vec::new();
            if let Some(fg) = self.master.process_group_leader() {
                groups.push(fg);
            }
            if let Some(pid) = self.shell_pid {
                groups.push(pid as libc::pid_t); // the shell leads its own session/group
            }
            groups.retain(|g| *g > 1);
            groups.dedup();
            for g in &groups {
                unsafe { libc::killpg(*g, libc::SIGHUP) };
            }
            let _ = self.killer.kill();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(1000));
                for g in groups {
                    unsafe { libc::killpg(g, libc::SIGKILL) }; // no-op if already gone
                }
            });
        }
        #[cfg(not(unix))]
        {
            let _ = self.killer.kill();
        }
    }
}

#[derive(Default, Clone)]
pub struct Terminals(Arc<Mutex<HashMap<u32, Session>>>);

static NEXT_ID: AtomicU32 = AtomicU32::new(1);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum TermEvent {
    Data { data: String },
    Exit { code: Option<u32> },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnOptions {
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    /// Program to run; empty = the user's login shell ($SHELL).
    #[serde(default)]
    shell: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: HashMap<String, String>,
}

fn default_shell() -> String {
    #[cfg(windows)]
    {
        std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".into())
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/zsh".into())
    }
}

#[tauri::command]
pub fn term_spawn(state: State<'_, Terminals>, options: SpawnOptions, on_event: Channel<TermEvent>) -> Result<u32, String> {
    let pty = native_pty_system();
    let pair = pty
        .openpty(PtySize { rows: options.rows.max(2), cols: options.cols.max(2), pixel_width: 0, pixel_height: 0 })
        .map_err(err)?;

    let shell = if options.shell.trim().is_empty() { default_shell() } else { options.shell.clone() };
    let mut cmd = CommandBuilder::new(&shell);
    if options.args.is_empty() {
        // A login shell, so PATH and friends match a normal terminal even though the app was
        // started from Finder (which doesn't run your shell profile).
        #[cfg(not(windows))]
        cmd.arg("-l");
    } else {
        cmd.args(&options.args);
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
    let cwd = options.cwd.filter(|c| std::path::Path::new(c).is_dir()).unwrap_or(home);
    cmd.cwd(cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "Slate");
    if std::env::var("LANG").is_err() {
        cmd.env("LANG", "en_US.UTF-8");
    }
    for (k, v) in &options.env {
        cmd.env(k, v);
    }

    let mut child = pair.slave.spawn_command(cmd).map_err(err)?;
    drop(pair.slave); // the child owns it now; dropping lets reads end when the shell exits
    let killer = child.clone_killer();
    let shell_pid = child.process_id();
    let mut reader = pair.master.try_clone_reader().map_err(err)?;
    let writer = pair.master.take_writer().map_err(err)?;
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    state.0.lock().unwrap().insert(id, Session { master: pair.master, writer, killer, shell_pid });

    let sessions = state.inner().clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        let mut pending: Vec<u8> = Vec::new(); // an incomplete UTF-8 sequence from the last read
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    let valid = match std::str::from_utf8(&pending) {
                        Ok(_) => pending.len(),
                        Err(e) if e.error_len().is_none() => e.valid_up_to(), // cut mid-character: keep the tail
                        Err(_) => pending.len(),                              // truly invalid bytes: send lossily
                    };
                    let data = String::from_utf8_lossy(&pending[..valid]).into_owned();
                    pending.drain(..valid);
                    if !data.is_empty() && on_event.send(TermEvent::Data { data }).is_err() {
                        break; // window gone
                    }
                }
            }
        }
        let code = child.wait().ok().map(|s| s.exit_code());
        sessions.0.lock().unwrap().remove(&id);
        let _ = on_event.send(TermEvent::Exit { code });
    });
    Ok(id)
}

#[tauri::command]
pub fn term_write(state: State<'_, Terminals>, id: u32, data: String) -> Result<(), String> {
    let mut sessions = state.0.lock().unwrap();
    let s = sessions.get_mut(&id).ok_or("terminal has exited")?;
    s.writer.write_all(data.as_bytes()).map_err(err)?;
    s.writer.flush().map_err(err)
}

#[tauri::command]
pub fn term_resize(state: State<'_, Terminals>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let sessions = state.0.lock().unwrap();
    let s = sessions.get(&id).ok_or("terminal has exited")?;
    s.master
        .resize(PtySize { rows: rows.max(2), cols: cols.max(2), pixel_width: 0, pixel_height: 0 })
        .map_err(err)
}

#[tauri::command]
pub fn term_kill(state: State<'_, Terminals>, id: u32) {
    let session = state.0.lock().unwrap().remove(&id);
    if let Some(s) = session {
        s.terminate();
    }
}

impl Terminals {
    /// Kills every shell (on quit), so no agents or servers keep running in the background.
    pub fn kill_all(&self) {
        let all: Vec<Session> = self.0.lock().unwrap().drain().map(|(_, s)| s).collect();
        for s in all {
            s.terminate();
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn running(pattern: &str) -> bool {
        std::process::Command::new("pgrep").args(["-f", pattern]).output().map(|o| !o.stdout.is_empty()).unwrap_or(false)
    }

    #[test]
    fn terminate_stops_the_foreground_program() {
        let pty = native_pty_system();
        let pair = pty.openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 }).unwrap();
        let mut cmd = CommandBuilder::new(default_shell());
        cmd.arg("-l");
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let killer = child.clone_killer();
        let shell_pid = child.process_id();
        let mut reader = pair.master.try_clone_reader().unwrap();
        std::thread::spawn(move || {
            let mut b = [0u8; 4096];
            while reader.read(&mut b).map(|n| n > 0).unwrap_or(false) {}
        });
        let mut writer = pair.master.take_writer().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1500));
        writer.write_all(b"sleep 8181\n").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(800));
        let fg = pair.master.process_group_leader();
        println!("shell pid={shell_pid:?} foreground group={fg:?} sleep running={}", running("sleep 8181"));
        let session = Session { master: pair.master, writer, killer, shell_pid };
        let t0 = std::time::Instant::now();
        session.terminate();
        let mut stopped = None;
        for _ in 0..40 {
            if !running("sleep 8181") {
                stopped = Some(t0.elapsed().as_millis());
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        println!("sleep stopped after: {stopped:?} ms");
        let _ = child.wait();
        assert!(stopped.is_some(), "foreground program survived terminate()");
    }
}
