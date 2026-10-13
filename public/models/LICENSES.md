# Super-resolution model licenses

The ONNX files in this directory were converted by us from the original PyTorch
weights (via spandrel + torch.onnx.export, then fp16 weights/compute via
onnxconverter-common with float32 I/O). Conversion is a modification of the
original weights; no other changes were made. Model metadata comes from
OpenModelDB (https://openmodeldb.info).

| File | License | Author |
|---|---|---|
| 4x-Nomos8k-span-otf-medium.onnx | CC-BY-4.0 | Helaman (Philip Hofmann) |
| 4x-Nomos2-hq-mosr.onnx | CC-BY-4.0 | Helaman (Philip Hofmann) |
| 4x-realesr-animevideo-v3.onnx | BSD-3-Clause | Xintao Wang (xinntao) |
| 4x-realesr-general-x4v3.onnx | BSD-3-Clause | Xintao Wang (xinntao) |

---

## 4x-Nomos8k-span-otf-medium (CC-BY-4.0)

- Author: Helaman (Philip Hofmann) — https://github.com/Phhofm/models
- OpenModelDB: https://openmodeldb.info/models/4x-Nomos8k-span-otf-medium
- Architecture: SPAN
- License: Creative Commons Attribution 4.0 International — https://creativecommons.org/licenses/by/4.0/

Attribution: "4xNomos8k_span_otf_medium" by Helaman (Philip Hofmann), licensed under
CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Source:
https://openmodeldb.info/models/4x-Nomos8k-span-otf-medium. Changes: converted from
PyTorch to ONNX with float16 weights.

## 4x-Nomos2-hq-mosr (CC-BY-4.0)

- Author: Helaman (Philip Hofmann) — https://github.com/Phhofm/models/releases/tag/4xNomos2_hq_mosr
- OpenModelDB: https://openmodeldb.info/models/4x-Nomos2-hq-mosr
- Architecture: MoSR
- License: Creative Commons Attribution 4.0 International — https://creativecommons.org/licenses/by/4.0/

Attribution: "4xNomos2_hq_mosr" by Helaman (Philip Hofmann), licensed under
CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Source:
https://openmodeldb.info/models/4x-Nomos2-hq-mosr. Changes: converted from PyTorch
to ONNX with float16 weights.

## Real-ESRGAN models (BSD-3-Clause)

Applies to:
- 4x-realesr-animevideo-v3 — https://openmodeldb.info/models/4x-realesr-animevideo-v3
- 4x-realesr-general-x4v3 — https://openmodeldb.info/models/4x-realesr-general-x4v3

Author: Xintao Wang (xinntao) — https://github.com/xinntao/Real-ESRGAN
License text (from https://github.com/xinntao/Real-ESRGAN/blob/master/LICENSE):

```
BSD 3-Clause License

Copyright (c) 2021, Xintao Wang
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```
