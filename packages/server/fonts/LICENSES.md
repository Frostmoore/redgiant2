# Fonts of the picture editor's text layers

The page and the server draw text layers with these very files (p3.5.8, `TEXT_FONTS` in
`@redgiant/protocol`, served by `GET /api/editor/fonts/:file`, never from a CDN). Liberation
Sans comes from pdf.js (`pdfjs-dist/standard_fonts`, its own licence file there); everything
here is carried by RedGiant.

All are under the **SIL Open Font License 1.1** (OFL-1.1): free to use, embed and redistribute
with software, the licence travelling with them (the `OFL-*.txt` files beside them).

| Family                            | Files                                           | Source                                                          | Licence                                                        | Carried                  |
| --------------------------------- | ----------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------ |
| Liberation Serif, Liberation Mono | `LiberationSerif-*.ttf`, `LiberationMono-*.ttf` | liberation-fonts 2.1.5 TTF release (github.com/liberationfonts) | OFL-1.1, Reserved Font Name «Liberation», `OFL-Liberation.txt` | unmodified               |
| Lato                              | `Lato-*.ttf`                                    | google/fonts `ofl/lato` (static)                                | OFL-1.1, Reserved Font Name «Lato», `OFL-Lato.txt`             | unmodified               |
| Inter                             | `Inter-*.ttf`                                   | google/fonts `ofl/inter` (variable)                             | OFL-1.1, `OFL-Inter.txt`                                       | static instances, subset |
| Roboto                            | `Roboto-*.ttf`                                  | google/fonts `ofl/roboto` (variable)                            | OFL-1.1, `OFL-Roboto.txt`                                      | static instances, subset |
| Noto Sans                         | `NotoSans-*.ttf`                                | google/fonts `ofl/notosans` (variable)                          | OFL-1.1, `OFL-NotoSans.txt`                                    | static instances, subset |
| Noto Serif                        | `NotoSerif-*.ttf`                               | google/fonts `ofl/notoserif` (variable)                         | OFL-1.1, `OFL-NotoSerif.txt`                                   | static instances, subset |
| Montserrat                        | `Montserrat-*.ttf`                              | google/fonts `ofl/montserrat` (variable)                        | OFL-1.1, `OFL-Montserrat.txt`                                  | static instances, subset |
| Open Sans                         | `OpenSans-*.ttf`                                | google/fonts `ofl/opensans` (variable)                          | OFL-1.1, `OFL-OpenSans.txt`                                    | static instances, subset |

A font with a Reserved Font Name is carried unmodified: the OFL forbids that name on a modified
version, and a subset or an instance is one. The others have none, so their modified versions
keep their names. Source Code Pro is not carried (Reserved Font Name «Source»; only its variable
file was at hand, and a static instance of it would be a modified version).

How the modified ones were made (`packages/server/scripts/text-fonts.py`, fontTools): a variable
font is cut at weight 400 (Regular, Italic) and 700 (Bold, BoldItalic), its italics from its own
italic file, so bold and italic are the designers' own, never synthesized; then each file is
subset to Latin (Basic Latin, Latin-1, Latin Extended-A and -B, common punctuation, the euro),
without hinting and without layout tables. About 6.3 MB together (5.3 MB of it the unmodified
Lato and Liberation files).
