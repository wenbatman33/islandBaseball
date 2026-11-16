"""用 Blender 建立 Q 版棒球員並算出正面、側面、背面與斜角預覽圖。

執行方式：
  /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup --python make_player.py -- <輸出資料夾>

座標：Z 朝上，角色面向 -Y，單位公尺，總高約 1.75。
造型依 public/models/_候選預覽/concept-player-sheet.png。
"""
import math
import os
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
TEX = os.path.join(HERE, "tex")
argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = argv[0] if argv else os.path.join(HERE, "out")
os.makedirs(OUT, exist_ok=True)

# ── 顏色 ──
C_JERSEY = "#f1e7cf"
C_ACCENT = "#1f4a36"
C_PANTS = "#efe4ca"
C_SKIN = "#f4c9a4"
C_HAIR = "#1c1b1b"
C_SHOE = "#3b3e43"
C_DARK = "#24272c"

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
COL = scene.collection


def srgb(hexstr):
    h = hexstr.lstrip("#")
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return [x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c] + [1.0]


_mats = {}


def material(color, rough=0.6):
    key = (color, rough)
    if key in _mats:
        return _mats[key]
    m = bpy.data.materials.new(f"mat_{color}_{rough}")
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = srgb(color)
    b.inputs["Roughness"].default_value = rough
    _mats[key] = m
    return m


def decal_material(name, filename):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes["Principled BSDF"]
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = bpy.data.images.load(os.path.join(TEX, filename))
    tex.extension = "CLIP"
    nt.links.new(tex.outputs["Color"], b.inputs["Base Color"])
    nt.links.new(tex.outputs["Alpha"], b.inputs["Alpha"])
    b.inputs["Roughness"].default_value = 0.6
    for attr, val in (("surface_render_method", "BLENDED"), ("blend_method", "BLEND")):
        try:
            setattr(m, attr, val)
        except Exception:
            pass
    return m


def make_obj(name, bm, mat, sub=2, solidify=0.0, smooth=True):
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    for p in mesh.polygons:
        p.use_smooth = smooth
    obj = bpy.data.objects.new(name, mesh)
    COL.objects.link(obj)
    obj.data.materials.append(mat)
    if solidify:
        s = obj.modifiers.new("solidify", "SOLIDIFY")
        s.thickness = solidify
        s.offset = 1.0
    if sub:
        m = obj.modifiers.new("subsurf", "SUBSURF")
        m.levels = sub
        m.render_levels = sub
    return obj


def revolve(name, profile, mat, matrix=None, yscale=1.0, segs=32, sub=2, solidify=0.0):
    """把 (半徑, 高度) 的輪廓繞 Z 軸旋轉成形，再套用 matrix。"""
    bm = bmesh.new()
    rings = []
    for r, z in profile:
        ring = []
        for i in range(segs):
            a = 2 * math.pi * i / segs
            ring.append(bm.verts.new((math.cos(a) * r, math.sin(a) * r * yscale, z)))
        rings.append(ring)
    for k in range(len(rings) - 1):
        for i in range(segs):
            j = (i + 1) % segs
            bm.faces.new([rings[k][i], rings[k][j], rings[k + 1][j], rings[k + 1][i]])
    if matrix is not None:
        bmesh.ops.transform(bm, matrix=matrix, verts=bm.verts)
    return make_obj(name, bm, mat, sub=sub, solidify=solidify)


def pill(name, p0, p1, r0, r1, mat, cap0=True, cap1=True, yscale=1.0):
    """兩端圓滑的管狀物，從 p0 到 p1。"""
    p0, p1 = Vector(p0), Vector(p1)
    axis = p1 - p0
    L = axis.length
    prof = []
    if cap0:
        prof += [(0.0006, -r0 * 0.85), (r0 * 0.72, -r0 * 0.55)]
    prof += [(r0, 0.0), (r0 + (r1 - r0) * 0.5, L * 0.5), (r1, L)]
    if cap1:
        prof += [(r1 * 0.72, L + r1 * 0.55), (0.0006, L + r1 * 0.85)]
    return revolve(name, prof, mat, matrix=align(p0, axis), yscale=yscale, segs=24)


def align(origin, zdir):
    """回傳把本地 Z 軸轉到 zdir、原點移到 origin 的矩陣。"""
    z = Vector(zdir).normalized()
    y = Vector((0, 1, 0))
    if abs(z.dot(y)) > 0.95:
        y = Vector((1, 0, 0))
    x = y.cross(z).normalized()
    y = z.cross(x).normalized()
    m = Matrix((x, y, z)).transposed().to_4x4()
    m.translation = Vector(origin)
    return m


def ellipsoid(name, center, radii, mat, matrix=None, segs=40, rings=24, sub=1):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=segs, v_segments=rings, radius=1.0)
    bmesh.ops.scale(bm, vec=Vector(radii), verts=bm.verts)
    if matrix is not None:
        bmesh.ops.transform(bm, matrix=matrix, verts=bm.verts)
    else:
        bmesh.ops.translate(bm, vec=Vector(center), verts=bm.verts)
    return make_obj(name, bm, mat, sub=sub)


def sph(center, radii, lon, lat, k=1.0):
    """橢球面上的點。lon 從正面 (-Y) 往 +X 量，lat 從赤道往上量（度）。"""
    lo, la = math.radians(lon), math.radians(lat)
    return Vector((
        center[0] + math.sin(lo) * math.cos(la) * radii[0] * k,
        center[1] - math.cos(lo) * math.cos(la) * radii[1] * k,
        center[2] + math.sin(la) * radii[2] * k,
    ))


def shell(name, center, radii, boundary, mat, solidify, lon_steps=72, lat_steps=40, lat_min=-70):
    """橢球殼：只保留 lat 高於 boundary(lon) 的部分（頭髮、帽子用）。"""
    bm = bmesh.new()
    grid = {}
    top = bm.verts.new(sph(center, radii, 0, 90))
    lats = [lat_min + (89 - lat_min) * j / lat_steps for j in range(lat_steps)]
    for i in range(lon_steps):
        lon = 360 * i / lon_steps
        b = boundary(lon)
        for j, lat in enumerate(lats):
            if lat >= b - 1e-6:
                grid[(i, j)] = bm.verts.new(sph(center, radii, lon, lat))
            elif j + 1 < lat_steps and lats[j + 1] >= b:
                grid[(i, j)] = bm.verts.new(sph(center, radii, lon, b))  # 把邊緣貼齊邊界
    for i in range(lon_steps):
        i2 = (i + 1) % lon_steps
        for j in range(lat_steps - 1):
            q = [grid.get((i, j)), grid.get((i2, j)), grid.get((i2, j + 1)), grid.get((i, j + 1))]
            if all(q):
                bm.faces.new(q)
        a, b2 = grid.get((i, lat_steps - 1)), grid.get((i2, lat_steps - 1))
        if a and b2:
            bm.faces.new([a, b2, top])
    return make_obj(name, bm, mat, sub=1, solidify=solidify)


def lock(name, center, radii, base, tip, width, thick, mat, lift=0.012, k=1.03):
    """一撮頭髮：沿頭的表面從 base(lon,lat) 到 tip(lon,lat) 的扁錐。"""
    bm = bmesh.new()
    c = Vector(center)
    steps = 5
    rings = []

    def at(t, extra=0.0):
        lon = base[0] + (tip[0] - base[0]) * t
        lat = base[1] + (tip[1] - base[1]) * t
        return sph(center, radii, lon, lat, k + extra)

    for s in range(steps + 1):
        t = s / steps
        p = at(t, lift * math.sin(math.pi * min(1.0, t * 1.15)) * 3)
        n = (p - c).normalized()
        d = (at(min(1, t + 0.05)) - at(max(0, t - 0.05))).normalized()
        side = n.cross(d).normalized()
        w = width * max(0.02, (1 - t) ** 0.75)
        th = thick * max(0.04, (1 - t) ** 0.6)
        ring = []
        for a_i in range(10):
            a = 2 * math.pi * a_i / 10
            ring.append(bm.verts.new(p + side * math.cos(a) * w + n * math.sin(a) * th))
        rings.append(ring)
    for s in range(steps):
        for i in range(10):
            j = (i + 1) % 10
            bm.faces.new([rings[s][i], rings[s][j], rings[s + 1][j], rings[s + 1][i]])
    bm.faces.new(rings[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return make_obj(name, bm, mat, sub=2)


def sphere_decal(name, center, radii, lon0, lon1, lat0, lat1, mat, k=1.004, target=None, offset=0.003, n=40):
    """貼在橢球面上的貼花，UV 依經緯度線性展開。"""
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new()
    vs = [[bm.verts.new(sph(center, radii, lon0 + (lon1 - lon0) * i / n, lat0 + (lat1 - lat0) * j / n, k))
           for j in range(n + 1)] for i in range(n + 1)]
    for i in range(n):
        for j in range(n):
            f = bm.faces.new([vs[i][j], vs[i + 1][j], vs[i + 1][j + 1], vs[i][j + 1]])
            for loop, (a, b) in zip(f.loops, ((i, j), (i + 1, j), (i + 1, j + 1), (i, j + 1))):
                loop[uv].uv = (a / n, b / n)
    obj = make_obj(name, bm, mat, sub=0)
    obj.visible_shadow = False
    if target is not None:
        m = obj.modifiers.new("wrap", "SHRINKWRAP")
        m.target = target
        m.wrap_method = "NEAREST_SURFACEPOINT"
        m.wrap_mode = "ABOVE_SURFACE"
        m.offset = offset
    return obj


def flat_decal(name, x0, x1, z0, z1, y, mat, target, toward_positive_y, offset=0.003, n=28):
    """先放在角色前方或後方的平面，再沿 Y 軸投影貼到 target 表面。"""
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new()
    vs = [[bm.verts.new((x0 + (x1 - x0) * i / n, y, z0 + (z1 - z0) * j / n)) for j in range(n + 1)] for i in range(n + 1)]
    for i in range(n):
        for j in range(n):
            f = bm.faces.new([vs[i][j], vs[i + 1][j], vs[i + 1][j + 1], vs[i][j + 1]])
            for loop, (a, b) in zip(f.loops, ((i, j), (i + 1, j), (i + 1, j + 1), (i, j + 1))):
                loop[uv].uv = (a / n, b / n)
    obj = make_obj(name, bm, mat, sub=0)
    obj.visible_shadow = False
    m = obj.modifiers.new("wrap", "SHRINKWRAP")
    m.target = target
    m.wrap_method = "PROJECT"
    m.use_project_x = False
    m.use_project_y = True
    m.use_project_z = False
    m.use_positive_direction = toward_positive_y
    m.use_negative_direction = not toward_positive_y
    m.offset = offset
    return obj


# ════════════════ 建模 ════════════════
M_JERSEY = material(C_JERSEY, 0.7)
M_ACCENT = material(C_ACCENT, 0.7)
M_PANTS = material(C_PANTS, 0.7)
M_SKIN = material(C_SKIN, 0.55)
M_HAIR = material(C_HAIR, 0.5)
M_SHOE = material(C_SHOE, 0.5)
M_DARK = material(C_DARK, 0.45)

# ── 腿、褲、鞋 ──
for s in (-1, 1):
    x = s * 0.112
    ellipsoid(f"sole_{s}", (x, -0.06, 0.024), (0.094, 0.182, 0.026), M_DARK)
    ellipsoid(f"shoe_{s}", (x, -0.055, 0.072), (0.09, 0.172, 0.074), M_SHOE)
    pill(f"sock_{s}", (x, 0, 0.1), (x, 0, 0.3), 0.064, 0.074, M_ACCENT, cap0=False, cap1=False)
    revolve(f"cuff_{s}", [(0.03, 0.25), (0.1, 0.258), (0.122, 0.295), (0.116, 0.34), (0.06, 0.36)], M_PANTS,
            matrix=Matrix.Translation((x, 0, 0)), segs=24)
    pill(f"leg_{s}", (x, 0, 0.31), (x * 0.86, 0, 0.66), 0.11, 0.14, M_PANTS)
ellipsoid("hips", (0, 0, 0.675), (0.236, 0.178, 0.12), M_PANTS)

# ── 皮帶 ──
revolve("belt", [(0.2, 0.728), (0.222, 0.735), (0.222, 0.782), (0.2, 0.789)], M_DARK, yscale=0.77, segs=40, sub=1)
bm = bmesh.new()
bmesh.ops.create_cube(bm, size=1.0)
bmesh.ops.scale(bm, vec=Vector((0.062, 0.016, 0.046)), verts=bm.verts)
bmesh.ops.translate(bm, vec=Vector((0, -0.172, 0.758)), verts=bm.verts)
make_obj("buckle", bm, material("#9aa0a6", 0.3), sub=0, smooth=False)

# ── 球衣 ──
jersey = revolve(
    "jersey",
    [(0.196, 0.745), (0.226, 0.775), (0.24, 0.86), (0.238, 0.95), (0.214, 1.03), (0.15, 1.085), (0.092, 1.108)],
    M_JERSEY, yscale=0.77, segs=44,
)
revolve("collar", [(0.084, 1.094), (0.104, 1.1), (0.108, 1.116), (0.09, 1.126), (0.078, 1.116)], M_ACCENT, yscale=0.86, segs=32, sub=1)
ellipsoid("neck", (0, 0, 1.1), (0.086, 0.074, 0.03), M_ACCENT)

# ── 手臂 ──
for s in (-1, 1):
    S = Vector((s * 0.212, 0, 1.03))
    d = Vector((s * 0.7, -0.03, -0.72)).normalized()
    revolve(f"sleeve_{s}", [(0.02, -0.05), (0.082, -0.02), (0.092, 0.06), (0.106, 0.165)], M_JERSEY,
            matrix=align(S, d), segs=24, solidify=0.012)
    pill(f"arm_{s}", S + d * 0.06, S + d * 0.4, 0.06, 0.05, M_ACCENT)
    hc = S + d * 0.47
    hm = align(hc, d)
    ellipsoid(f"hand_{s}", None, (0.066, 0.05, 0.088), M_SKIN, matrix=hm)
    ellipsoid(f"thumb_{s}", hc + Vector((-s * 0.03, -0.045, 0.03)), (0.026, 0.03, 0.042), M_SKIN)

# ── 頭 ──
HC = (0, 0, 1.405)
HR = (0.305, 0.3, 0.29)
head = ellipsoid("head", HC, HR, M_SKIN, segs=64, rings=40)
for s in (-1, 1):
    ellipsoid(f"ear_{s}", sph(HC, HR, s * 90, -10, 0.985), (0.03, 0.05, 0.066), M_SKIN)
sphere_decal("face", HC, HR, -60, 60, -65, 55, decal_material("face", "face.png"))

# ── 頭髮 ──
HAIR_R = tuple(r * 1.028 for r in HR)


def hair_edge(lon):
    a = abs(((lon + 180) % 360) - 180)  # 與正面的夾角
    if a < 70:
        return 36
    if a < 104:
        return 36 - (a - 70) / 34 * 22  # 耳朵上方：頭髮停在耳朵之上
    if a < 128:
        return 14 - (a - 104) / 24 * 26
    return -12


shell("hair", HC, HAIR_R, hair_edge, M_HAIR, solidify=0.014)
bangs = [(-50, -58, -2), (-26, -22, 8), (-2, 6, 0), (22, 28, 9), (48, 56, -3)]
for i, (b_lon, t_lon, t_lat) in enumerate(bangs):
    lock(f"bang_{i}", HC, HR, (b_lon, 48), (t_lon, t_lat), 0.09, 0.032, M_HAIR)
for s in (-1, 1):
    lock(f"burn_{s}", HC, HR, (s * 74, 22), (s * 70, -12), 0.036, 0.02, M_HAIR)
for i, lon in enumerate(range(123, 238, 19)):
    lock(f"nape_{i}", HC, HR, (lon, -2), (lon + (4 if i % 2 else -4), -30 - (8 if i % 2 else 0)), 0.082, 0.03, M_HAIR)

# ── 帽子 ──
CC = (0, 0.0, 1.425)
CR = (0.326, 0.334, 0.318)


def cap_edge(lon):
    return 16 + 12 * math.cos(math.radians(lon))


cap = shell("cap", CC, CR, cap_edge, M_ACCENT, solidify=0.008, lat_min=0)
ellipsoid("button", sph(CC, CR, 0, 90, 1.02), (0.03, 0.03, 0.014), M_ACCENT)
# 帽簷
bm = bmesh.new()
NA, NT = 18, 6
grid = []
for i in range(NA + 1):
    a = -58 + 116 * i / NA
    rim = sph(CC, CR, a, cap_edge(a), 1.01)
    out = Vector((math.sin(math.radians(a)), -math.cos(math.radians(a)), 0))
    L = 0.23 * max(0.0, math.cos(math.radians(a * 90 / 58))) ** 0.7
    row = []
    for j in range(NT + 1):
        t = -0.12 + 1.12 * j / NT
        droop = -0.035 * max(0, t) - 0.045 * max(0, t) ** 2 - 0.03 * math.sin(math.radians(a)) ** 2 * max(0, t)
        row.append(bm.verts.new(rim + out * (t * L) + Vector((0, 0, droop))))
    grid.append(row)
for i in range(NA):
    for j in range(NT):
        bm.faces.new([grid[i][j], grid[i][j + 1], grid[i + 1][j + 1], grid[i + 1][j]])
make_obj("brim", bm, M_ACCENT, sub=2, solidify=0.014)
sphere_decal("logo", CC, CR, -22, 22, 37, 67, decal_material("logo", "logo_cat.png"), k=1.02, target=cap, offset=0.004, n=24)

# ── 球衣貼花 ──
flat_decal("placket", -0.05, 0.05, 0.79, 1.075, -0.4, decal_material("placket", "placket.png"), jersey, True)
flat_decal("number", 0.18, -0.18, 0.8, 1.04, 0.4, decal_material("number", "number_17.png"), jersey, False)

# ════════════════ 場景與算圖 ════════════════
bm = bmesh.new()
bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=12)
ground = make_obj("ground", bm, material("#c9cbd0", 1.0), sub=0, smooth=False)

world = bpy.data.worlds.new("world")
world.use_nodes = True
world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.74, 0.75, 0.78, 1)
world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.6
scene.world = world

rig = bpy.data.objects.new("light_rig", None)
COL.objects.link(rig)


def area(name, loc, energy, size, color=(1, 1, 1)):
    data = bpy.data.lights.new(name, "AREA")
    data.energy = energy
    data.size = size
    data.color = color
    ob = bpy.data.objects.new(name, data)
    COL.objects.link(ob)
    ob.location = loc
    ob.parent = rig
    direction = Vector((0, 0, 0.95)) - Vector(loc)
    ob.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    return ob


area("key", (-2.6, -4.2, 4.2), 430, 3.5, (1.0, 0.97, 0.92))
area("fill", (3.6, -3.0, 2.0), 150, 4.5, (0.9, 0.95, 1.0))
area("rim", (0.5, 4.2, 3.6), 260, 3.0)

cam_data = bpy.data.cameras.new("cam")
cam = bpy.data.objects.new("cam", cam_data)
COL.objects.link(cam)
scene.camera = cam

for name in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"):
    try:
        scene.render.engine = name
        break
    except Exception:
        continue
print("算圖引擎:", scene.render.engine)
try:
    scene.eevee.taa_render_samples = 48
except Exception:
    pass
scene.view_settings.view_transform = "Standard"
scene.render.image_settings.file_format = "PNG"
scene.render.film_transparent = False


def shoot(name, angle_deg, ortho=True, res=(900, 1200), dist=7.0, height=0.9, elev=0.0):
    a = math.radians(angle_deg)
    rig.rotation_euler = (0, 0, a)
    pos = Vector((math.sin(a) * dist, -math.cos(a) * dist, height + elev))
    cam.location = pos
    cam.rotation_euler = (Vector((0, 0, height)) - pos).to_track_quat("-Z", "Y").to_euler()
    if ortho:
        cam_data.type = "ORTHO"
        cam_data.ortho_scale = 2.05
    else:
        cam_data.type = "PERSP"
        cam_data.lens = 85
    scene.render.resolution_x, scene.render.resolution_y = res
    scene.render.filepath = os.path.join(OUT, name)
    bpy.ops.render.render(write_still=True)
    print("已輸出", name)


shoot("front.png", 0)
shoot("side.png", 90)
shoot("back.png", 180)
shoot("hero.png", -32, ortho=False, res=(1200, 1400), dist=6.4, height=0.95, elev=0.55)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, "player_v1.blend"))
print("完成")
