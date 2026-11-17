"""Meshy 模型共用的處理：切出帽子、標記布料／皮膚區域（給遊戲換隊色用）。由 rig_v6.py、rig_v7.py 載入。"""
import bpy
import numpy as np

NECK_Z = 1.54  # 領口高度（身高 1.90 m 的座標）：以上不會有布料


def split_cap(ob, z_min):
    """Meshy 的模型帽子和頭是同一塊網格。依貼圖顏色把頭頂的深綠色面切出來成為獨立的 cap，
    遊戲裡打者才能藏起帽子、換上頭盔（帽子底下沒有頭髮，會被頭盔蓋住）。"""
    img = next(n.image for n in ob.data.materials[0].node_tree.nodes if n.type == "TEX_IMAGE")
    w, h = img.size
    px = np.array(img.pixels[:]).reshape(h, w, 4)
    uv = ob.data.uv_layers.active.data
    sel = []
    for p in ob.data.polygons:
        u = sum(uv[i].uv.x for i in p.loop_indices) / p.loop_total
        v = sum(uv[i].uv.y for i in p.loop_indices) / p.loop_total
        r, g, b, _ = px[min(h - 1, int(v * h)) % h, min(w - 1, int(u * w)) % w]
        z = (ob.matrix_world @ p.center).z
        sel.append(bool(z > z_min and g > r + 0.015 and g >= b and r + g + b < 0.9))
    me = ob.data
    for p, s in zip(me.polygons, sel):
        p.select = s
    bpy.context.view_layer.objects.active = ob
    for o in bpy.data.objects:
        o.select_set(o is ob)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_mode(type="FACE")
    bpy.ops.object.mode_set(mode="OBJECT")
    for p, s in zip(me.polygons, sel):
        p.select = s
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.separate(type="SELECTED")
    bpy.ops.object.mode_set(mode="OBJECT")
    new = next(o for o in bpy.data.objects if o.type == "MESH" and o is not ob and o.name.startswith(ob.name))
    new.name = "cap"
    new.data.name = "cap"
    print(f"帽子切出 {sum(sel)} 面")
    return new


def mark_regions(ob):
    """每個三角形取貼圖上 7 個點的多數顏色，標成「球衣布料」或「皮膚」，寫進頂點顏色（R＝布料、G＝皮膚）。
    遊戲換隊色時整塊布料直接換色，不再逐點猜（Meshy 貼圖細節多，逐點判斷會漏掉很多點，深色球衣上出現白色斑點）。"""
    img = next(n.image for n in ob.data.materials[0].node_tree.nodes if n.type == "TEX_IMAGE")
    w, h = img.size
    px = np.array(img.pixels[:]).reshape(h, w, 4)[:, :, :3]
    me = ob.data
    uv = np.array([d.uv[:] for d in me.uv_layers.active.data])
    BARY = np.array([[1 / 3, 1 / 3, 1 / 3], [0.6, 0.2, 0.2], [0.2, 0.6, 0.2], [0.2, 0.2, 0.6], [0.45, 0.45, 0.1], [0.45, 0.1, 0.45], [0.1, 0.45, 0.45]])
    attr = me.color_attributes.new("region", "BYTE_COLOR", "CORNER")
    counts = {"布料": 0, "皮膚": 0, "其他": 0}
    for p in me.polygons:
        li = list(p.loop_indices)[:3]
        pts = BARY @ uv[li]
        xs = np.clip((pts[:, 0] * w).astype(int), 0, w - 1)
        ys = np.clip((pts[:, 1] * h).astype(int), 0, h - 1)
        c = px[ys, xs]
        r, g, b = c[:, 0], c[:, 1], c[:, 2]
        lum = 0.299 * r + 0.587 * g + 0.114 * b
        green = (g - np.maximum(r, b)) > 0.03
        ratio = np.minimum(np.minimum(r, g), b) / np.maximum(np.maximum(r, g), np.maximum(b, 1e-3))
        cream = (lum > 0.45) & (ratio > 0.72) & ~green
        skin = (r > g) & (g > b) & ((r - b) > 0.12) & (lum > 0.2) & ~cream
        n_c, n_s, n_g = cream.sum(), skin.sum(), green.sum()
        z = (ob.matrix_world @ p.center).z
        # 球衣上的滾邊、鈕扣只是細節：布料佔多數就整塊算布料；領口以上不會有布料
        is_cloth = z < NECK_Z - 0.02 and n_c >= 3 and n_c >= n_s
        is_skin = not is_cloth and n_s >= 4
        col = (1.0 if is_cloth else 0.0, 1.0 if is_skin else 0.0, 0.0, 1.0)
        for i in p.loop_indices:
            attr.data[i].color = col
        counts["布料" if is_cloth else "皮膚" if is_skin else "其他"] += 1
    me.color_attributes.active_color = attr
    print(f"區域標記：{counts}")
