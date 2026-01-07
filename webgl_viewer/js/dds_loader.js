/**
 * Minimal DDS loader focused on block-compressed formats used by GTA (BC1/3/4/5/6H/7).
 *
 * Why:
 * - CodeWalker.Core cannot CPU-decode BC7 (TODO in DDSIO.GetPixels), but the GPU can often sample it.
 * - We export DDS as a "fastest" Gen9 fallback, then upload via WebGL2 compressed texture extensions.
 *
 * Limitations (by design):
 * - Only supports 2D textures (no cube/array/3D).
 * - Only supports block-compressed DDS (DXT1/3/5, ATI1/ATI2, DX10 BC6H/BC7).
 */

function _u32(dv, off) { return dv.getUint32(off, true); }

function _fourCCToString(u32) {
  const a = String.fromCharCode(u32 & 0xFF);
  const b = String.fromCharCode((u32 >> 8) & 0xFF);
  const c = String.fromCharCode((u32 >> 16) & 0xFF);
  const d = String.fromCharCode((u32 >> 24) & 0xFF);
  return `${a}${b}${c}${d}`;
}

function _isWebGL2(gl) {
  try {
    return (typeof WebGL2RenderingContext !== 'undefined') && (gl instanceof WebGL2RenderingContext);
  } catch {
    return false;
  }
}

export function parseDds(arrayBuffer) {
  const ab = arrayBuffer;
  if (!ab || ab.byteLength < 128) throw new Error(`DDS: buffer too small (${ab?.byteLength || 0})`);
  const dv = new DataView(ab);
  const magic = _u32(dv, 0);
  if (magic !== 0x20534444) throw new Error('DDS: bad magic (expected "DDS ")');
  const size = _u32(dv, 4);
  if (size !== 124) throw new Error(`DDS: unexpected header size=${size}`);

  const height = _u32(dv, 12);
  const width = _u32(dv, 16);
  const mipMapCount = Math.max(1, _u32(dv, 28) || 1);

  // Pixel format block starts at offset 76.
  const pfSize = _u32(dv, 76);
  if (pfSize !== 32) throw new Error(`DDS: unexpected pfSize=${pfSize}`);
  const pfFlags = _u32(dv, 80);
  const pfFourCC = _u32(dv, 84);
  const fourCC = _fourCCToString(pfFourCC);

  const caps2 = _u32(dv, 112);
  const isCube = (caps2 & 0x00000200) !== 0; // DDSCAPS2_CUBEMAP
  if (isCube) throw new Error('DDS: cubemap not supported');

  let dxgiFormat = null;
  let dataOffset = 128;
  if ((pfFlags & 0x00000004) !== 0 && fourCC === 'DX10') {
    if (ab.byteLength < 148) throw new Error('DDS: missing DX10 header');
    dxgiFormat = _u32(dv, 128);
    // const resourceDimension = _u32(dv, 132);
    // const miscFlag = _u32(dv, 136);
    const arraySize = _u32(dv, 140);
    if (arraySize !== 1) throw new Error(`DDS: arraySize=${arraySize} not supported`);
    dataOffset = 148;
  }

  return {
    width,
    height,
    mipMapCount,
    fourCC,
    dxgiFormat,
    dataOffset,
  };
}

function _blockBytesForFormat(info) {
  // BC1 / BC4 => 8 bytes per 4x4 block
  // BC2/3/5/6H/7 => 16 bytes per 4x4 block
  const fourCC = String(info.fourCC || '');
  const dxgi = info.dxgiFormat;
  if (fourCC === 'DXT1' || fourCC === 'ATI1') return 8;
  if (fourCC === 'DXT3' || fourCC === 'DXT5' || fourCC === 'ATI2') return 16;
  // DXGI block-compressed formats:
  // 95/96 BC6H, 98/99 BC7, 71 BC1, 74 BC2, 77 BC3, 80 BC4, 83 BC5
  if (dxgi === 71 || dxgi === 80) return 8;
  if (dxgi === 74 || dxgi === 77 || dxgi === 83 || dxgi === 95 || dxgi === 96 || dxgi === 98 || dxgi === 99) return 16;
  return 0;
}

function _mipSizeBytes(w, h, blockBytes) {
  const bw = Math.max(1, Math.ceil(w / 4));
  const bh = Math.max(1, Math.ceil(h / 4));
  return bw * bh * blockBytes;
}

function _getCompressedInternalFormat(gl, info, { kind = 'diffuse' } = {}) {
  const fourCC = String(info.fourCC || '');
  const dxgi = info.dxgiFormat;
  const k = String(kind || 'diffuse').toLowerCase();
  const wantSrgb = (k === 'diffuse' || k === 'diffuse2' || k === 'emissive');

  const isWebGL2 = _isWebGL2(gl);
  if (!isWebGL2) throw new Error('DDS: requires WebGL2 for compressed uploads in this viewer');

  const extS3tc = gl.getExtension('WEBGL_compressed_texture_s3tc');
  const extS3tcSrgb = gl.getExtension('WEBGL_compressed_texture_s3tc_srgb');
  const extRgtc = gl.getExtension('EXT_texture_compression_rgtc');
  const extBptc = gl.getExtension('EXT_texture_compression_bptc');

  const ret = (internalFormat, uploadedAsSrgb) => ({ internalFormat, uploadedAsSrgb: !!uploadedAsSrgb });

  // Legacy FourCC path (common DDS writers).
  if (fourCC === 'DXT1') {
    if (!extS3tc) throw new Error('DDS: missing WEBGL_compressed_texture_s3tc (DXT1)');
    if (wantSrgb && extS3tcSrgb?.COMPRESSED_SRGB_ALPHA_S3TC_DXT1_EXT) return ret(extS3tcSrgb.COMPRESSED_SRGB_ALPHA_S3TC_DXT1_EXT, true);
    return ret(extS3tc.COMPRESSED_RGBA_S3TC_DXT1_EXT, false);
  }
  if (fourCC === 'DXT3') {
    if (!extS3tc) throw new Error('DDS: missing WEBGL_compressed_texture_s3tc (DXT3)');
    if (wantSrgb && extS3tcSrgb?.COMPRESSED_SRGB_ALPHA_S3TC_DXT3_EXT) return ret(extS3tcSrgb.COMPRESSED_SRGB_ALPHA_S3TC_DXT3_EXT, true);
    return ret(extS3tc.COMPRESSED_RGBA_S3TC_DXT3_EXT, false);
  }
  if (fourCC === 'DXT5') {
    if (!extS3tc) throw new Error('DDS: missing WEBGL_compressed_texture_s3tc (DXT5)');
    if (wantSrgb && extS3tcSrgb?.COMPRESSED_SRGB_ALPHA_S3TC_DXT5_EXT) return ret(extS3tcSrgb.COMPRESSED_SRGB_ALPHA_S3TC_DXT5_EXT, true);
    return ret(extS3tc.COMPRESSED_RGBA_S3TC_DXT5_EXT, false);
  }
  if (fourCC === 'ATI1') {
    if (!extRgtc) throw new Error('DDS: missing EXT_texture_compression_rgtc (ATI1/BC4)');
    return ret(extRgtc.COMPRESSED_RED_RGTC1_EXT, false);
  }
  if (fourCC === 'ATI2') {
    if (!extRgtc) throw new Error('DDS: missing EXT_texture_compression_rgtc (ATI2/BC5)');
    return ret(extRgtc.COMPRESSED_RG_RGTC2_EXT, false);
  }

  // DX10 path (DXGI format codes).
  if (dxgi === 71) {
    if (!extS3tc) throw new Error('DDS: missing WEBGL_compressed_texture_s3tc (BC1)');
    if (wantSrgb && extS3tcSrgb?.COMPRESSED_SRGB_ALPHA_S3TC_DXT1_EXT) return ret(extS3tcSrgb.COMPRESSED_SRGB_ALPHA_S3TC_DXT1_EXT, true);
    return ret(extS3tc.COMPRESSED_RGBA_S3TC_DXT1_EXT, false);
  }
  if (dxgi === 74) {
    if (!extS3tc) throw new Error('DDS: missing WEBGL_compressed_texture_s3tc (BC2)');
    if (wantSrgb && extS3tcSrgb?.COMPRESSED_SRGB_ALPHA_S3TC_DXT3_EXT) return ret(extS3tcSrgb.COMPRESSED_SRGB_ALPHA_S3TC_DXT3_EXT, true);
    return ret(extS3tc.COMPRESSED_RGBA_S3TC_DXT3_EXT, false);
  }
  if (dxgi === 77) {
    if (!extS3tc) throw new Error('DDS: missing WEBGL_compressed_texture_s3tc (BC3)');
    if (wantSrgb && extS3tcSrgb?.COMPRESSED_SRGB_ALPHA_S3TC_DXT5_EXT) return ret(extS3tcSrgb.COMPRESSED_SRGB_ALPHA_S3TC_DXT5_EXT, true);
    return ret(extS3tc.COMPRESSED_RGBA_S3TC_DXT5_EXT, false);
  }
  if (dxgi === 80) {
    if (!extRgtc) throw new Error('DDS: missing EXT_texture_compression_rgtc (BC4)');
    return ret(extRgtc.COMPRESSED_RED_RGTC1_EXT, false);
  }
  if (dxgi === 83) {
    if (!extRgtc) throw new Error('DDS: missing EXT_texture_compression_rgtc (BC5)');
    return ret(extRgtc.COMPRESSED_RG_RGTC2_EXT, false);
  }
  if (dxgi === 95 || dxgi === 96) {
    if (!extBptc) throw new Error('DDS: missing EXT_texture_compression_bptc (BC6H)');
    // BC6H is HDR (float). Treat as data texture (linear).
    return ret((dxgi === 95) ? extBptc.COMPRESSED_RGB_BPTC_UNSIGNED_FLOAT_EXT : extBptc.COMPRESSED_RGB_BPTC_SIGNED_FLOAT_EXT, false);
  }
  if (dxgi === 98 || dxgi === 99) {
    if (!extBptc) throw new Error('DDS: missing EXT_texture_compression_bptc (BC7)');
    if (wantSrgb && extBptc.COMPRESSED_SRGB_ALPHA_BPTC_UNORM_EXT) return ret(extBptc.COMPRESSED_SRGB_ALPHA_BPTC_UNORM_EXT, true);
    return ret(extBptc.COMPRESSED_RGBA_BPTC_UNORM_EXT, false);
  }

  throw new Error(`DDS: unsupported format fourCC=${fourCC} dxgi=${dxgi}`);
}

export function uploadDdsToTexture(gl, arrayBuffer, { tier = 'high', kind = 'diffuse' } = {}) {
  const info = parseDds(arrayBuffer);
  const blockBytes = _blockBytesForFormat(info);
  if (!blockBytes) throw new Error(`DDS: unsupported/computed blockBytes=0 (fourCC=${info.fourCC} dxgi=${info.dxgiFormat})`);

  const mipStart = (() => {
    const t = String(tier || 'high').toLowerCase();
    if (t === 'low') return 2;
    if (t === 'medium') return 1;
    return 0;
  })();
  const start = Math.min(Math.max(0, mipStart), Math.max(0, (info.mipMapCount | 0) - 1));

  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);

  // Try to keep parity with the PNG upload path (flip Y). Implementations may ignore this for compressed.
  try { gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true); } catch { /* ignore */ }

  const fmt = _getCompressedInternalFormat(gl, info, { kind });
  const internalFormat = fmt.internalFormat;

  // Upload mip chain starting at "start" as level 0.
  let offset = info.dataOffset;
  let uploadedBytes = 0;
  let w = info.width;
  let h = info.height;

  // Skip bytes for mips before "start".
  for (let i = 0; i < start; i++) {
    const size = _mipSizeBytes(w, h, blockBytes);
    offset += size;
    w = Math.max(1, w >> 1);
    h = Math.max(1, h >> 1);
  }

  const maxLevels = info.mipMapCount - start;
  for (let level = 0; level < maxLevels; level++) {
    const size = _mipSizeBytes(w, h, blockBytes);
    if (offset + size > arrayBuffer.byteLength) {
      throw new Error(`DDS: mip ${level} out of range (need ${size} bytes at ${offset}, buf=${arrayBuffer.byteLength})`);
    }
    const data = new Uint8Array(arrayBuffer, offset, size);
    gl.compressedTexImage2D(gl.TEXTURE_2D, level, internalFormat, w, h, 0, data);
    uploadedBytes += size;
    offset += size;
    w = Math.max(1, w >> 1);
    h = Math.max(1, h >> 1);
  }

  const t = String(tier || 'high').toLowerCase();
  const useMips = (t !== 'low') && (maxLevels > 1);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, useMips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);

  // Aniso (optional; best-effort).
  if (useMips) {
    try {
      const extAniso =
        gl.getExtension('EXT_texture_filter_anisotropic')
        || gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic')
        || gl.getExtension('MOZ_EXT_texture_filter_anisotropic');
      if (extAniso) {
        const maxA = gl.getParameter(extAniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) || 1;
        const wantA = Math.min(8, Math.max(1, Number(maxA) || 1));
        gl.texParameterf(gl.TEXTURE_2D, extAniso.TEXTURE_MAX_ANISOTROPY_EXT, wantA);
      }
    } catch { /* ignore */ }
  }

  return { tex, bytes: uploadedBytes, uploadedAsSrgb: !!fmt.uploadedAsSrgb };
}


