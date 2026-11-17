"""檢查 GLB 模型是否破碎：合併重複頂點後，統計獨立碎塊、破洞邊界與非流形邊。

執行：
  /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup --python check_integrity.py -- <模型.glb>
"""
import sys

import bmesh
import bpy

argv = sys.argv[sys.argv.index("--") + 1:]
GLB = argv[0]

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=GLB)

for ob in [o for o in bpy.context.scene.objects if o.type == "MESH"]:
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bm.transform(ob.matrix_world)
    # UV 接縫會把頂點拆開，先合併才看得到真正的幾何破洞
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bm.verts.ensure_lookup_table()
    h = max(v.co.z for v in bm.verts) - min(v.co.z for v in bm.verts)

    # 用面相連找獨立碎塊
    seen, parts = set(), []
    for f in bm.faces:
        if f.index in seen:
            continue
        stack, comp = [f], []
        seen.add(f.index)
        while stack:
            cur = stack.pop()
            comp.append(cur)
            for e in cur.edges:
                for nf in e.link_faces:
                    if nf.index not in seen:
                        seen.add(nf.index)
                        stack.append(nf)
        zs = [v.co.z for ff in comp for v in ff.verts]
        parts.append((len(comp), min(zs), max(zs)))
    parts.sort(reverse=True)

    boundary = [e for e in bm.edges if len(e.link_faces) == 1]
    nonmani = [e for e in bm.edges if len(e.link_faces) > 2]
    zero = sum(1 for f in bm.faces if f.calc_area() < 1e-12)

    print(f"=== {ob.name} ===")
    print(f"高度 {h:.3f}  頂點 {len(bm.verts)}  面 {len(bm.faces)}")
    print(f"獨立碎塊 {len(parts)}（主體 {parts[0][0]} 面）")
    for n, z0, z1 in parts[1:15]:
        print(f"  碎塊 {n} 面  高度 {z0:.2f}～{z1:.2f}")
    print(f"破洞邊界邊 {len(boundary)}  非流形邊 {len(nonmani)}  零面積面 {zero}")
    bm.free()
