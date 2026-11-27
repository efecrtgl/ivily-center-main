//! Child-process ownership.
//!
//! Every long-lived process Ivily Center starts (language servers, debug adapters, tasks) is placed
//! in its own Windows Job Object with `KILL_ON_JOB_CLOSE`. Dropping the [`ProcessJob`] — or Ivily
//! Center exiting for any reason, including a crash — terminates the process **and every process it
//! spawned** (e.g. `tsserver` started by `typescript-language-server`). No orphans are left behind.

use crate::error::{AppError, AppResult};

pub struct ProcessJob {
    #[cfg(windows)]
    handle: windows_sys::Win32::Foundation::HANDLE,
}

// The handle is only used for Assign/Close, which are thread-safe kernel calls.
unsafe impl Send for ProcessJob {}
unsafe impl Sync for ProcessJob {}

impl ProcessJob {
    /// Create a job that kills its processes when closed.
    pub fn new() -> AppResult<Self> {
        #[cfg(windows)]
        unsafe {
            use windows_sys::Win32::System::JobObjects::*;
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return Err(AppError::Internal("CreateJobObject failed".into()));
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok == 0 {
                windows_sys::Win32::Foundation::CloseHandle(handle);
                return Err(AppError::Internal("SetInformationJobObject failed".into()));
            }
            Ok(Self { handle })
        }
        #[cfg(not(windows))]
        Ok(Self {})
    }

    /// Put a freshly spawned child into the job (its future children inherit the job).
    pub fn assign(&self, child: &std::process::Child) -> AppResult<()> {
        #[cfg(windows)]
        unsafe {
            use std::os::windows::io::AsRawHandle;
            let ok = windows_sys::Win32::System::JobObjects::AssignProcessToJobObject(
                self.handle,
                child.as_raw_handle() as _,
            );
            if ok == 0 {
                return Err(AppError::Internal("AssignProcessToJobObject failed".into()));
            }
        }
        #[cfg(not(windows))]
        let _ = child;
        Ok(())
    }

    /// Put a process into the job by its raw handle (e.g. a ConPTY child).
    ///
    /// # Safety
    /// `handle` must be a valid process handle with `PROCESS_SET_QUOTA | PROCESS_TERMINATE`
    /// access for the duration of the call.
    #[cfg(windows)]
    pub unsafe fn assign_raw(&self, handle: std::os::windows::io::RawHandle) -> AppResult<()> {
        let ok = windows_sys::Win32::System::JobObjects::AssignProcessToJobObject(self.handle, handle as _);
        if ok == 0 {
            return Err(AppError::Internal("AssignProcessToJobObject failed".into()));
        }
        Ok(())
    }
}

impl Drop for ProcessJob {
    fn drop(&mut self) {
        #[cfg(windows)]
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.handle);
        }
    }
}

/// `CREATE_NO_WINDOW` for console tools started in the background.
#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn dropping_the_job_kills_the_process_tree() {
        use std::process::{Command, Stdio};
        use std::time::{Duration, Instant};
        let job = ProcessJob::new().unwrap();
        // A parent that starts a child, both sleeping for a long time.
        let mut parent = Command::new("cmd")
            .args([
                "/C",
                "start",
                "/B",
                "ping",
                "-n",
                "60",
                "127.0.0.1",
                ">NUL",
                "&",
                "ping",
                "-n",
                "60",
                "127.0.0.1",
                ">NUL",
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        job.assign(&parent).unwrap();
        std::thread::sleep(Duration::from_millis(300));
        drop(job);
        let start = Instant::now();
        while parent.try_wait().unwrap().is_none() {
            assert!(start.elapsed() < Duration::from_secs(5), "process survived job close");
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}
