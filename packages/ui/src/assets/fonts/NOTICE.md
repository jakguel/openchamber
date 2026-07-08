# Vendored Nerd icon fonts — provenance & license

These woff2 files supply the Private-Use-Area icon glyphs (U+E000–F8FF,
U+F0000–FFFFF) used by the integrated terminal. They are self-hosted so the
glyphs render fully offline (same-origin) across every OpenChamber surface
(web, electron, vscode, mobile, mini-chat). They replace the previous
`cdn.jsdelivr.net` delivery.

## Files

| File | Family (`font-family`) | Base font | Nerd Fonts patch |
|------|------------------------|-----------|------------------|
| `JetBrainsMonoNerdFont-Regular.woff2` | `JetBrainsMono Nerd Font` | JetBrains Mono | Nerd Fonts v3.3.0 |
| `FiraCodeNerdFont-Regular.woff2` | `FiraCode Nerd Font` | Fira Code | Nerd Fonts v3.3.0 |

## Provenance (pinned)

- Nerd Fonts release: `ryanoasis/nerd-fonts` v3.3.0
  (https://github.com/ryanoasis/nerd-fonts/releases/tag/v3.3.0)
- Web-font (woff2) build source: `mshaugh/nerdfont-webfonts` tag `v3.3.0`
  (https://github.com/mshaugh/nerdfont-webfonts/tree/v3.3.0/build/fonts)
- Downloaded from the GitHub raw source at that tag (byte-identical to the
  files previously served via jsdelivr):
  - `https://raw.githubusercontent.com/mshaugh/nerdfont-webfonts/v3.3.0/build/fonts/JetBrainsMonoNerdFont-Regular.woff2`
  - `https://raw.githubusercontent.com/mshaugh/nerdfont-webfonts/v3.3.0/build/fonts/FiraCodeNerdFont-Regular.woff2`

### SHA-256

```
72e1e04361a5b9a23de8abf9ba383c0ca420e21d963e603a11496bac0915f554  JetBrainsMonoNerdFont-Regular.woff2
ef53992cdf469d4024d2efc29d51c05a65425d1ca690e505fab80223980a067d  FiraCodeNerdFont-Regular.woff2
```

## License

JetBrains Mono, Fira Code, and the Nerd Fonts glyph patches are all licensed
under the SIL Open Font License, Version 1.1. The full license text follows.

---

Copyright (c) 2020, JetBrains (https://www.jetbrains.com/), with Reserved Font Name "JetBrains Mono".
Copyright (c) 2014, The Fira Code Project Authors (https://github.com/tonsky/FiraCode), with Reserved Font Name "Fira Code".
Copyright (c) 2016, Ryan L McIntyre (https://ryanlmcintyre.com), with Reserved Font Name "Symbols Nerd Font".

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
https://openfontlicense.org

-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply to any
document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical writer or
other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining a
copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components, in
Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or in
the appropriate machine-readable metadata fields within text or binary
files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any Modified
Version, except to acknowledge the contribution(s) of the Copyright
Holder(s) and the Author(s) or with their explicit written permission.

5) The Font Software, modified or unmodified, in part or in whole, must be
distributed entirely under this license, and must not be distributed under
any other license. The requirement for fonts to remain under this license
does not apply to any document created using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are not
met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF
COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM OTHER
DEALINGS IN THE FONT SOFTWARE.

---

# Vendored @fontsource text-catalog fonts — provenance & license

These woff2 supply the user-selectable UI/monospace catalog fonts. They were
previously fetched at runtime from a public CDN by `lib/fontLoader.ts`, which
broke offline use. They are now self-hosted so a catalog font selection loads
same-origin/offline. Only the latin subset in the weights the catalog requests
is vendored; loading stays lazy (only the selected family downloads).

## Provenance (pinned @fontsource package versions)

Files are the byte-identical `files/<prefix>-latin-<weight>-normal.woff2`
artifacts copied from the installed @fontsource npm packages at these versions:

| Family | @fontsource package | Version | Weights | License |
|--------|---------------------|---------|---------|---------|
| Inter | `@fontsource/inter` | 5.2.8 | 400,500,600 | OFL 1.1 |
| Geist Sans | `@fontsource/geist-sans` | 5.2.5 | 400,500,600 | OFL 1.1 |
| Atkinson Hyperlegible | `@fontsource/atkinson-hyperlegible` | 5.2.8 | 400,700 | OFL 1.1 |
| Source Sans 3 | `@fontsource/source-sans-3` | 5.2.9 | 400,500,600 | OFL 1.1 |
| Roboto | `@fontsource/roboto` | 5.2.10 | 400,500,600 | Apache-2.0 |
| Noto Sans | `@fontsource/noto-sans` | 5.2.10 | 400,500,600 | OFL 1.1 |
| DM Sans | `@fontsource/dm-sans` | 5.2.8 | 400,500,600 | OFL 1.1 |
| Manrope | `@fontsource/manrope` | 5.2.8 | 400,500,600 | OFL 1.1 |
| JetBrains Mono | `@fontsource/jetbrains-mono` | 5.2.8 | 400,500,600 | OFL 1.1 |
| Fira Code | `@fontsource/fira-code` | 5.2.7 | 400,500,600 | OFL 1.1 |
| Geist Mono | `@fontsource/geist-mono` | 5.2.8 | 400,500,600 | OFL 1.1 |
| Commit Mono | `@fontsource/commit-mono` | 5.2.5 | 400,500,600 | OFL 1.1 |
| Source Code Pro | `@fontsource/source-code-pro` | 5.2.7 | 400,500,600 | OFL 1.1 |
| Cascadia Code | `@fontsource/cascadia-code` | 5.2.3 | 400,500,600 | OFL 1.1 |
| Roboto Mono | `@fontsource/roboto-mono` | 5.2.9 | 400,500,600 | Apache-2.0 |
| Iosevka | `@fontsource/iosevka` | 5.2.5 | 400,500,600 | OFL 1.1 |

## License

The OFL-1.1 families are covered by the SIL Open Font License, Version 1.1,
whose full text appears above. Roboto and Roboto Mono are licensed under the
Apache License, Version 2.0 (https://www.apache.org/licenses/LICENSE-2.0).

## SHA-256

```
d64ba838ef5472bba248620ec4fd8b5aa7cf0db2908e0bb230600caf279ba7bc  atkinson-hyperlegible-latin-400-normal.woff2
140e2bd25a7315c8a062508391426b0d8c3297400c947b8d847be28f73a199f0  atkinson-hyperlegible-latin-700-normal.woff2
923fd5a61f1618f4597422b66172d0d8615577f81eb9382724390ec8cb8bfd5d  cascadia-code-latin-400-normal.woff2
d4994c01c11d6b9a49a2b44e0a3711934c99a35268ab9303a7b9dcc30495341e  cascadia-code-latin-500-normal.woff2
be5e5cbe3958e21cf2c7404e09853dcc83cf667e71327264274dd26fc8d92d9b  cascadia-code-latin-600-normal.woff2
86132abb57fc615f2ab900cde4cd9d5796e9791daf1f85d79fc933aa50b3b15c  commit-mono-latin-400-normal.woff2
ff7e7c2446edb30d854a636c0e5edefbf90c5739476779636d83448797e2e2de  commit-mono-latin-500-normal.woff2
48b7064512777b347f5338f1e30b69e27c1164f5e4a9e8d5310b5f953fe50bde  commit-mono-latin-600-normal.woff2
4ab51eb2cd7305d177187908d6397474d4520663f6c6e572feb0a64f4fa80006  dm-sans-latin-400-normal.woff2
19bf1984956517c35c2bd35b6cdedac12a21d6fcd3596c614ecdfb88b648909d  dm-sans-latin-500-normal.woff2
6bb2b2645ba5eeaecf56322c543fa3a75b87b927977b9c03b1dabc4205089120  dm-sans-latin-600-normal.woff2
6dc9da171ccea71d525379ee1cbf51d143e31acac330a251bb71b3d6060e687c  fira-code-latin-400-normal.woff2
9e4da5ad2c147be02544df5a732d22830a82b1e9800dc06267ba656f5c40f7e9  fira-code-latin-500-normal.woff2
53bd904d81c086b103b9e01ef84a98640b2124b78c789bb47ddabb4c41fc94b2  fira-code-latin-600-normal.woff2
6b2e3719a213e34cc043760e5a5b420d4067f477dfe06b92ef3c9fd914192dd4  geist-mono-latin-400-normal.woff2
53cb4eeb92ea2af00279675f699917ae96d9682b1fa5b563def7c02e8c9a2b60  geist-mono-latin-500-normal.woff2
aa6729a1d4c5e788db486def8aec71f558556b86534cc12459d03361c568fe33  geist-mono-latin-600-normal.woff2
e6ef6abb39c762ed2259cc814e6f16888c540cd84835962227b56ab2354f27f1  geist-sans-latin-400-normal.woff2
40073e90816315c92e4f4381bd50b6fdc950b22b0dd010a4179046cf588d4f12  geist-sans-latin-500-normal.woff2
9d99fbd791968493fa507ac846de561cee47b00f8100c23cad333b3cb78392d6  geist-sans-latin-600-normal.woff2
8909904ab6c872eb994093482a88a28eca2cd95912d7b6fecd72103b0dc07edc  inter-latin-400-normal.woff2
f3779f1efccc4bdcdf9c0a02ab95bf6bd092ed09c48c08cedc725889edd1d19f  inter-latin-500-normal.woff2
f9a06e79cd3a2a20951c0f0e28f66dd0e6d3fda73911d640a2125c8fcb78f21a  inter-latin-600-normal.woff2
edd37efeaa39d005a13b7e1770f42a474cfd7dc22e4b7091c5783cec9dcdc794  iosevka-latin-400-normal.woff2
303500455d9bed7f67d7c1488a6682dc4ccf7ef8dc0ee4402b9193b6b248fd19  iosevka-latin-500-normal.woff2
e62b5c737cb05005f2e8746e8e51db0f1932168c200e015a788409ea0f2172ce  iosevka-latin-600-normal.woff2
14425ba9c695763c1547f48a206b7aa60350a33ae23de09f0407877f3fcd89eb  jetbrains-mono-latin-400-normal.woff2
cb182feeed4d798ff6961d3c79f7026279448fca0676438aaecb21f3fc39553a  jetbrains-mono-latin-500-normal.woff2
400c6bfda18d5d14acad1c15d6dcb9f8e13c015e7286317e0b9a482539bef147  jetbrains-mono-latin-600-normal.woff2
849290ef12a2eeb9af5c11924120d11aa4ae8b435ed3347d7fc8bc240c293ca3  manrope-latin-400-normal.woff2
19874318747181a650eda439c37955220b849d9c4797c9e0718ee67d4bf929bc  manrope-latin-500-normal.woff2
f7ac6258da20ab7541939b59851155753d1d24f1b30cbcb949077a3faa3d1593  manrope-latin-600-normal.woff2
09aee8065d25508f23a4c3d92cd777ac869c52d93fd868a88f025d888a7937d6  noto-sans-latin-400-normal.woff2
1d35aaecc5c7a375d87c12787e1e4c5d6a695315b757e1e18a479d1a2f84e973  noto-sans-latin-500-normal.woff2
79e274470d1c5a0118eb325e2ea6f2eb2a449336d7fde1a4f20a2f32fe1119ed  noto-sans-latin-600-normal.woff2
425c0713a8176f92273d378599c7eac57de7fafabd4bd0ed457b70eb8f80d371  roboto-latin-400-normal.woff2
5bcc3aa180e7f26f643cd5b2621cd7c2de193d0661d913a94afd3d4881a7a34b  roboto-latin-500-normal.woff2
3eac5e2f468629b4673394bb25a387aba117e0dfa646b7f371a2cbd2bbf91d87  roboto-latin-600-normal.woff2
e03013e0baa5690a803c188da2214d920c3245b25ad78421ecc8ae86cd842ae9  roboto-mono-latin-400-normal.woff2
ce7027efa5c894e8b244b0ca05ec121b6a85655957afd9c76c59b56910de7d4e  roboto-mono-latin-500-normal.woff2
0ee2e6f8f9dcd2af7bc0c6b519c283954242824258b652cdb6017bc578e2c493  roboto-mono-latin-600-normal.woff2
75aa8cacfd459d58d7c093f3ff0ab8745cc878dfc93c5d4cda052791aeace878  source-code-pro-latin-400-normal.woff2
8966fa3fbe70f63675bbededb8389023c07258bc46a831fd6d146cb062a5811f  source-code-pro-latin-500-normal.woff2
0d1ec7219990cad29c487df2e1fc6651671fd5224daec191cae5f649824cb7bd  source-code-pro-latin-600-normal.woff2
0f73f35e08cde0a2f10c109c6e01d71459d97e4099ecd9a50f1b6c0209e4de2b  source-sans-3-latin-400-normal.woff2
3b3a8b8e4a422ff71c9ffb0836a4d48ff337a4419b878214f65d6ebe0f59fa51  source-sans-3-latin-500-normal.woff2
14527d193b0e30bc32ef931549a246cdfd286573bb12869b7e052b8101a39d38  source-sans-3-latin-600-normal.woff2
```

---

# Vendored Hack Nerd Font — provenance & license

These woff2 supply the opt-in `Hack Nerd Font` catalog monospace: the Hack
typeface patched with Nerd Fonts icon glyphs (Private-Use-Area). It is a
user-selectable catalog font only — never a default — and loads same-origin,
lazily on selection via `lib/fontLoader.ts` (same local glob-map loader as the
@fontsource catalog above). Only Regular (400) and Bold (700) are vendored;
catalog weight requests 500/600 resolve to the nearest available face via
native CSS font-weight matching (500->400, 600->700).

## Files

| File | Family (`font-family`) | Base font | Nerd Fonts patch | Weight |
|------|------------------------|-----------|------------------|--------|
| `hack-latin-400-normal.woff2` | `Hack Nerd Font` | Hack | Nerd Fonts v3.3.0 | 400 (Regular) |
| `hack-latin-700-normal.woff2` | `Hack Nerd Font` | Hack | Nerd Fonts v3.3.0 | 700 (Bold) |

The files are renamed from the upstream `HackNerdFont-Regular.woff2` /
`HackNerdFont-Bold.woff2` to the `<prefix>-latin-<weight>-normal.woff2`
convention required by the local font loader's glob-map key derivation.

## Provenance (pinned)

- Nerd Fonts release: `ryanoasis/nerd-fonts` v3.3.0
  (https://github.com/ryanoasis/nerd-fonts/releases/tag/v3.3.0)
- Web-font (woff2) build source: `mshaugh/nerdfont-webfonts` tag `v3.3.0`
  (https://github.com/mshaugh/nerdfont-webfonts/tree/v3.3.0/build/fonts)
  - `https://raw.githubusercontent.com/mshaugh/nerdfont-webfonts/v3.3.0/build/fonts/HackNerdFont-Regular.woff2`
  - `https://raw.githubusercontent.com/mshaugh/nerdfont-webfonts/v3.3.0/build/fonts/HackNerdFont-Bold.woff2`

## License

The Hack typeface is licensed under the MIT License (with a bundled font
license notice). Hack is a fork of, and derives its Latin glyph outlines from,
Bitstream Vera Sans Mono and DejaVu Sans Mono, which carry the Bitstream Vera
and DejaVu (Bitstream Vera-derived) font licenses. The Nerd Fonts icon-glyph
patch (`Symbols Nerd Font`, Copyright (c) 2016, Ryan L McIntyre) is licensed
under the SIL Open Font License, Version 1.1 (full text above).

### Hack — MIT License

```
The MIT License (MIT)

Copyright (c) 2018 Source Foundry Authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Bitstream Vera / DejaVu heritage notice

Hack's Latin glyphs derive from the Bitstream Vera Sans Mono and DejaVu Sans
Mono families. The Bitstream Vera Fonts are Copyright (c) 2003 by Bitstream,
Inc.; "Bitstream Vera" is a trademark of Bitstream, Inc. DejaVu changes are in
the public domain. Both are distributed under permissive font licenses that
permit redistribution, modification, and embedding; the reserved font names
("Bitstream Vera", "DejaVu") are not used by this derivative.

### SHA-256

```
80489a64799e725f4a40e0fc1cd50e949c1e50e9feee82b30cbf047b4658f7fa  hack-latin-400-normal.woff2
bdf8f067d7b31db99b1818db5ad073b5d2dbb4bff1b13302335edcf38b775b42  hack-latin-700-normal.woff2
```
