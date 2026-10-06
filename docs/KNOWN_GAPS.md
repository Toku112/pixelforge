# Known gaps

Things that are impossible (or not yet possible) in a browser, or deliberately not replicated, with the closest
alternative we implement instead (CLAUDE.md §4 "When you are unsure").

| Area                          | Gap                                                                                                  | Alternative / status                                                                                |
| ----------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 3D                            | The reference app removed its 3D feature set; we do not implement 3D.                                | None — out of scope (PLAN B14).                                                                     |
| Filter plugins                | Native binary filter plugins (8BF) cannot run in a browser.                                          | Our own sandboxed plugin API (PLAN B19).                                                            |
| Cloud services                | Vendor stock-photo, fonts, cloud documents, boards and social-portfolio services are not replicated. | Local projects in OPFS, local asset library, open font sources only with owner approval (PLAN B24). |
| Colour management (temporary) | Until lcms2 lands (Phase 7), images are treated as sRGB and embedded ICC profiles are not applied.   | Planned for Phase 7.                                                                                |
