use std::ffi::c_void;

const SYNCHRONIZE: u32 = 0x0010_0000;
const ERROR_INVALID_PARAMETER: u32 = 87;
const WAIT_OBJECT_0: u32 = 0;

#[link(name = "kernel32")]
extern "system" {
    #[link_name = "OpenProcess"]
    fn open_process(access: u32, inherit: i32, pid: u32) -> *mut c_void;
    #[link_name = "WaitForSingleObject"]
    fn wait_for_single_object(handle: *mut c_void, milliseconds: u32) -> u32;
    #[link_name = "CloseHandle"]
    fn close_handle(handle: *mut c_void) -> i32;
    #[link_name = "GetLastError"]
    fn get_last_error() -> u32;
}

fn retain_after_open_error(error: u32) -> bool {
    // A nonexistent PID yields ERROR_INVALID_PARAMETER. Access denial and
    // other unknown failures do not prove termination: preserve the session.
    error != ERROR_INVALID_PARAMETER
}

pub(super) fn pid_is_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }

    // SAFETY: request only synchronization access to an existing process;
    // the handle is never inherited and no signal or mutation is performed.
    let handle = unsafe { open_process(SYNCHRONIZE, 0, pid) };
    if handle.is_null() {
        // SAFETY: read the error immediately after the failed Win32 call.
        return retain_after_open_error(unsafe { get_last_error() });
    }

    // SAFETY: this is a valid owned process handle, kept open through the
    // zero-timeout wait and closed exactly once afterward. A signaled process
    // has terminated; timeout or unknown wait failure conservatively retains it.
    let outcome = unsafe { wait_for_single_object(handle, 0) };
    unsafe { close_handle(handle) };
    outcome != WAIT_OBJECT_0
}

#[cfg(test)]
mod tests {
    use super::{pid_is_alive, retain_after_open_error};

    #[test]
    fn current_process_is_alive() {
        assert!(pid_is_alive(std::process::id()));
    }

    #[test]
    fn zero_is_not_a_session_process() {
        assert!(!pid_is_alive(0));
    }

    #[test]
    fn exited_child_is_not_alive() {
        let mut child = std::process::Command::new("cmd")
            .args(["/C", "exit", "0"])
            .spawn()
            .expect("start isolated child");
        let pid = child.id();
        child.wait().expect("wait for isolated child");
        assert!(!pid_is_alive(pid));
    }

    #[test]
    fn live_child_is_alive() {
        let mut child = std::process::Command::new("cmd")
            .args(["/C", "pause"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .spawn()
            .expect("start isolated live child");
        let alive = pid_is_alive(child.id());
        child.kill().expect("stop isolated live child");
        child.wait().expect("reap isolated live child");
        assert!(alive);
    }

    #[test]
    fn access_denial_and_unknown_errors_preserve_sessions() {
        assert!(retain_after_open_error(5)); // ERROR_ACCESS_DENIED
        assert!(retain_after_open_error(8)); // ERROR_NOT_ENOUGH_MEMORY
        assert!(!retain_after_open_error(87)); // ERROR_INVALID_PARAMETER
    }
}
