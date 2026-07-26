# RAR recovery fixtures

Source: [openwall/john-samples](https://github.com/openwall/john-samples) (RAR / RAR5).
Password for all encrypted samples: `password`

| File                  | Format | Notes                                                                                                    |
| --------------------- | ------ | -------------------------------------------------------------------------------------------------------- |
| rar3-p0.rar           | RAR3   | Content encrypted. Too small for reliable `rar2john`/`john` load; 7-Zip known-password path still works. |
| rar3-hp0.rar          | RAR3   | Header + content encrypted (`$RAR3$*0*`). Dictionary recovery supported.                                 |
| rar5-p0-password.rar  | RAR5   | Content encrypted. Dictionary recovery supported.                                                        |
| rar5-hp0-password.rar | RAR5   | Header + content encrypted. Dictionary recovery supported.                                               |

## Boundaries

- Bundled 7-Zip can extract RAR but cannot create RAR archives for synthetic fixtures.
- John hash lines must not keep Windows absolute paths in the leading label (`F:\...` breaks `:` field splitting). The recovery pipeline rewrites labels to `archive:`.
