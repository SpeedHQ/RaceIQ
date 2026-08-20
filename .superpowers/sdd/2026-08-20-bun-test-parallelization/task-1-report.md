

## Reviewer fix round 2

Status remains: DONE_WITH_CONCERNS.

Windows staging no longer uses per-file symlinks. Runner copies manifest test files on Windows, avoiding Developer Mode/elevated privilege requirements; POSIX retains file symlinks. Directory junctions remain for `server` and `test/support` on Windows. Focused unit rerun passed 5/5; focused integration database-path rerun passed 4/4.
