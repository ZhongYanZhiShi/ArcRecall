use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;

use sha2::{Digest, Sha256};

use super::CancellationToken;

pub(super) fn check_cancelled(cancellation: &CancellationToken) -> io::Result<()> {
    if cancellation.is_cancelled() {
        // Interrupted is retried by io::copy, so use a terminal error instead.
        return Err(io::Error::other("引擎安装已取消"));
    }
    Ok(())
}

pub(super) struct CancellableReader<'a, R> {
    inner: R,
    cancellation: &'a CancellationToken,
}

impl<'a, R> CancellableReader<'a, R> {
    pub(super) fn new(inner: R, cancellation: &'a CancellationToken) -> Self {
        Self {
            inner,
            cancellation,
        }
    }
}

impl<R: Read> Read for CancellableReader<'_, R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        check_cancelled(self.cancellation)?;
        let count = self.inner.read(buffer)?;
        check_cancelled(self.cancellation)?;
        Ok(count)
    }
}

impl<R: Seek> Seek for CancellableReader<'_, R> {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        check_cancelled(self.cancellation)?;
        self.inner.seek(position)
    }
}

pub(super) fn sha256_file(path: &Path, cancellation: &CancellationToken) -> io::Result<String> {
    let mut file = CancellableReader::new(File::open(path)?, cancellation);
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(hex::encode(hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_stops_copy_instead_of_retrying() {
        let token = CancellationToken::default();
        struct CancelOnRead(CancellationToken);
        impl Read for CancelOnRead {
            fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
                self.0.cancel();
                buffer[0] = 1;
                Ok(1)
            }
        }
        let mut reader = CancellableReader::new(CancelOnRead(token.clone()), &token);
        let mut output = Vec::new();
        assert!(io::copy(&mut reader, &mut output).is_err());
        assert!(output.is_empty());
    }
}
