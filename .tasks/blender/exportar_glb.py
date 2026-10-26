"""Escritório nó · export da cena aprovada (e804351b) para o site (Rodada 5)

Uso, a partir da raiz da worktree:
    "C:/Program Files/Blender Foundation/Blender 5.2/blender.exe" -b .tasks/blender/escritorio.blend -P .tasks/blender/exportar_glb.py
    (acrescente  -- --sem-bake  para pular o bake e reaproveitar os atlas já salvos)

Saídas:
    .tasks/blender/exportado/escritorio-bruto.glb      export do Blender, sem compressão
    .tasks/blender/exportado/assado-a.png, assado-b.png atlas de luz assada (Cycles)
    agentes/escritorio/escritorio.glb                   depois do gltf-transform (meshopt + WebP)

O que o site lê (nomes exatos, ver .tasks/agentes-escritorio.md, Rodada 5):
    câmeras ortográficas camera-tela1, camera-tela2-fiscal, camera-tela2-auditor, camera-fecho;
    marcadores marca-mesa-*, marca-pessoa-*, marca-recepcao, marca-sala, marca-etiqueta-*,
    marca-logo-balcao, marca-piso; caixas toque-mesa-*; pessoa-fiscal, pessoa-auditor com
    os clips laco-fiscal e laco-auditor; cracha-<agente> com o material cracha-faixa-<agente>;
    sala-tech-stack e a placa (extras.texto = "nó tech stack"); cabo-fiscal, cabo-auditor,
    cabo-vaga com o material cabo e UV0.u de 0 na mesa a 1 na sala.
Os objetos estáticos viram dois atlas de luz assada (extras.assado = 1): o site os desenha
com MeshBasicMaterial. Pessoas, cabos, vidro e placa ficam com material próprio.
"""
import bpy, bmesh, math, os, sys, json, time, subprocess
from mathutils import Vector, Matrix
from bpy_extras import anim_utils

T0 = time.time()
AQUI = os.path.dirname(os.path.abspath(__file__))
RAIZ = os.path.abspath(os.path.join(AQUI, '..', '..'))
SAIDA = os.path.join(AQUI, 'exportado')
os.makedirs(SAIDA, exist_ok=True)
ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
FAZ_BAKE = '--sem-bake' not in ARGS
cena = bpy.context.scene
O = bpy.data.objects
V = lambda x=0, y=0, z=0: Vector((x, y, z))
def log(*a): print('EXPORT', round(time.time() - T0, 1), *a, flush=True)

def lin(h):
    h = h.lstrip('#'); out = []
    for i in (0, 2, 4):
        c = int(h[i:i + 2], 16) / 255
        out.append(c / 12.92 if c <= .04045 else ((c + .055) / 1.055) ** 2.4)
    return (*out, 1.0)
MARCA = json.load(open(os.path.join(AQUI, 'texturas', 'cores.json'), encoding='utf8'))

def apaga(ob):
    for f in list(ob.children_recursive): bpy.data.objects.remove(f, do_unlink=True)
    bpy.data.objects.remove(ob, do_unlink=True)
def vazio(nome, matriz, pai=None):
    e = bpy.data.objects.new(nome, None); e.empty_display_size = .1
    cena.collection.objects.link(e)
    if pai is not None:
        e.parent = pai; e.matrix_parent_inverse = pai.matrix_world.inverted()
    e.matrix_world = matriz
    return e
cena.frame_set(1)
bpy.context.view_layer.update()
def principled(m):
    """devolve o Principled do material, criando e ligando à saída se faltar (Blender 5)"""
    m.use_nodes = True
    nt = m.node_tree
    pb = next((n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if pb is None:
        pb = nt.nodes.new('ShaderNodeBsdfPrincipled')
        out = next((n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL'), None) or nt.nodes.new('ShaderNodeOutputMaterial')
        nt.links.new(pb.outputs[0], out.inputs['Surface'])
    return pb

# ───────────── 1. marcadores, renomes e limpeza ─────────────
for id_ in ('fiscal', 'auditor', 'vaga'):
    pl = O['etiqueta-' + id_]
    vazio('marca-etiqueta-' + id_, Matrix.Translation(pl.matrix_world.translation), O['mesa-' + id_])
logo = O['logo-balcao']
vazio('marca-logo-balcao', logo.matrix_world @ Matrix.Diagonal((1.0, 964 / 1633, 1.0, 1.0)), O['recepcao'])
vazio('marca-piso', Matrix.Translation(V(0, 0, 0)))
for nome in ['etiqueta-fiscal', 'etiqueta-auditor', 'etiqueta-vaga', 'etiqueta-vaga-contorno', 'logo-balcao', 'Arrasto_Tela1_Fecho']:
    if nome in O: apaga(O[nome])
for o in [o for o in O if o.name.startswith('pulso-')]: apaga(o)
for velho, novo in [('Tela1', 'camera-tela1'), ('Tela2_fiscal', 'camera-tela2-fiscal'), ('Tela2_auditor', 'camera-tela2-auditor'), ('Fecho_sala', 'camera-fecho')]:
    O[velho].name = novo; O[novo].data.name = novo
for ag in ('fiscal', 'auditor'):
    bpy.data.materials['cracha-borda-' + ag].name = 'cracha-faixa-' + ag
O['placa-tech-stack']['texto'] = 'nó tech stack'
log('marcadores ok')

# ───────────── 2. corte: só o que aparece nos quadros (proporção até 1,1, +10%) ─────────────
cam1 = O['camera-tela1']
DIREITA = cam1.matrix_world.col[0].xyz.normalized(); CIMA = cam1.matrix_world.col[1].xyz.normalized()
tela = lambda p: (p.dot(DIREITA), p.dot(CIMA))
PARA_CAMERA = cam1.matrix_world.col[2].xyz.normalized()   # do mundo para a câmera
sx0 = sy0 = 1e9; sx1 = sy1 = -1e9
for nome in ('camera-tela1', 'camera-fecho', 'camera-tela2-fiscal', 'camera-tela2-auditor'):
    c = O[nome]; H = c.data.ortho_scale
    cx, cy = tela(c.matrix_world.translation)
    hw, hh = H * 1.1 * 1.1 / 2, H * 1.1 / 2
    sx0, sx1, sy0, sy1 = min(sx0, cx - hw), max(sx1, cx + hw), min(sy0, cy - hh), max(sy1, cy + hh)
log('regiao', [round(v, 2) for v in (sx0, sx1, sy0, sy1)])
def cantos_tela(raiz):
    pts = []
    for o in [raiz] + list(raiz.children_recursive):
        if o.type in ('MESH', 'CURVE'):
            pts += [tela(o.matrix_world @ Vector(c)) for c in o.bound_box]
    return pts
PROTEGE = ('camera-', 'marca-', 'sol', 'preenchimento', 'sala-luz')
cortados = []
for o in [o for o in O if o.parent is None and not o.name.startswith(PROTEGE)]:
    pts = cantos_tela(o)
    if not pts: continue
    if all(p[0] < sx0 for p in pts) or all(p[0] > sx1 for p in pts) or all(p[1] < sy0 for p in pts) or all(p[1] > sy1 for p in pts):
        cortados.append(o.name); apaga(o)
log('fora do quadro', len(cortados), cortados)

def aplica_modificadores(ob):
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
    velho = ob.data; ob.modifiers.clear(); ob.data = me
    if velho.users == 0: bpy.data.meshes.remove(velho)
def recorta(ob):
    """corta a malha pelos quatro planos da região (cada plano contém a direção da câmera)"""
    aplica_modificadores(ob)
    bm = bmesh.new(); bm.from_mesh(ob.data)
    bmesh.ops.transform(bm, matrix=ob.matrix_world, verts=bm.verts)
    for n, d, lado in [(DIREITA, sx0, -1), (DIREITA, sx1, 1), (CIMA, sy0, -1), (CIMA, sy1, 1)]:
        geom = list(bm.verts) + list(bm.edges) + list(bm.faces)
        r = bmesh.ops.bisect_plane(bm, geom=geom, plane_co=n * d, plane_no=n * lado, clear_outer=True)
        fecho = [e for e in r['geom_cut'] if isinstance(e, bmesh.types.BMEdge)]
        if fecho: bmesh.ops.holes_fill(bm, edges=fecho)
    bmesh.ops.transform(bm, matrix=ob.matrix_world.inverted(), verts=bm.verts)
    bm.to_mesh(ob.data); bm.free()
for nome in ('piso', 'parede-fundo', 'rodape'):
    recorta(O[nome])
log('piso e parede recortados')

# ───────────── 3. cabos: malha com UV0.u da mesa (0) à sala (1) ─────────────
m_cabo = bpy.data.materials.new('cabo'); pb = principled(m_cabo)
pb.inputs['Base Color'].default_value = lin(MARCA['azul']); pb.inputs['Roughness'].default_value = .28
for id_ in ('fiscal', 'auditor', 'vaga'):
    ob = O['cabo-' + id_]
    cu = ob.data
    pts = [ob.matrix_world @ Vector(p.co[:3]) for p in cu.splines[0].points]
    acum = [0.0]
    for a, b in zip(pts, pts[1:]): acum.append(acum[-1] + (b - a).length)
    total = acum[-1]
    cu.animation_data_clear(); cu.bevel_factor_start = 0; cu.bevel_factor_end = 1
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg), depsgraph=dg)
    novo = bpy.data.objects.new('tmp-' + id_, me); cena.collection.objects.link(novo)
    novo.matrix_world = ob.matrix_world
    apaga(ob); novo.name = 'cabo-' + id_
    me.materials.clear(); me.materials.append(m_cabo)
    for p in me.polygons: p.use_smooth = True
    # u = comprimento de arco do ponto mais próximo na polilinha / comprimento total
    uv = me.uv_layers.new(name='UVMap')
    us = []
    for v in me.vertices:
        w = novo.matrix_world @ v.co; melhor = (1e9, 0)
        for i, (a, b) in enumerate(zip(pts, pts[1:])):
            ab = b - a; t = max(0, min(1, (w - a).dot(ab) / max(ab.length_squared, 1e-9)))
            d = (a + ab * t - w).length_squared
            if d < melhor[0]: melhor = (d, (acum[i] + ab.length * t) / total)
        us.append(melhor[1])
    for lp in me.loops:
        uv.data[lp.index].uv = (us[lp.vertex_index], .5)
    novo['cabo'] = 1
    log('cabo', id_, 'vertices', len(me.vertices), 'z min', round(min((novo.matrix_world @ v.co).z for v in me.vertices), 4))

# ───────────── 4. clips: as ações de cada pessoa viram um clip único com slots ─────────────
def fcurves_de(ob):
    ad = ob.animation_data
    if not ad or not ad.action: return []
    cb = anim_utils.action_get_channelbag_for_slot(ad.action, ad.action_slot)
    return list(cb.fcurves) if cb else []
for ag in ('fiscal', 'auditor'):
    raiz = O['pessoa-' + ag]
    act = bpy.data.actions.new('laco-' + ag)
    camada = act.layers.new('laco'); faixa = camada.strips.new(type='KEYFRAME')
    n = 0
    for ob in [raiz] + list(raiz.children_recursive):
        fcs = fcurves_de(ob)
        if not fcs: continue
        dados = [(fc.data_path, fc.array_index, [(k.co[0], k.co[1], k.interpolation) for k in fc.keyframe_points]) for fc in fcs]
        velha = ob.animation_data.action
        slot = act.slots.new(id_type='OBJECT', name=ob.name)
        ob.animation_data.action = act; ob.animation_data.action_slot = slot
        cb = faixa.channelbags.new(slot)
        for caminho, idx, ks in dados:
            fc = cb.fcurves.new(caminho, index=idx)
            fc.keyframe_points.add(len(ks))
            for kp, (q, val, interp) in zip(fc.keyframe_points, ks):
                kp.co = (q, val); kp.interpolation = interp
            fc.update()
        if velha.users == 0: bpy.data.actions.remove(velha)
        n += 1
    act.use_fake_user = True
    log('clip', act.name, 'objetos', n)
cena.frame_start, cena.frame_end = 1, 193        # 192 intervalos = 8 s a 24 fps, primeiro e último quadro iguais

# ───────────── 5. bake da luz no Cycles (dois atlas de 2048) ─────────────
GRUPO_A = ['piso', 'parede-fundo', 'rodape', 'tapete-banco', 'tapete-estar']
pessoas = set()
for ag in ('fiscal', 'auditor'):
    pessoas |= {o.name for o in [O['pessoa-' + ag]] + list(O['pessoa-' + ag].children_recursive)}
def estatico(o):
    if o.type != 'MESH' or o.name in pessoas or o.name.startswith(('cabo-', 'placa-tech-stack')): return False
    if any(m and m.name == 'vidro' for m in o.data.materials): return False
    return True
estaticos = [o for o in O if estatico(o)]
grupo_a = [o for o in estaticos if o.name in GRUPO_A]
grupo_b = [o for o in estaticos if o.name not in GRUPO_A]
log('estaticos', len(estaticos), 'A', len(grupo_a), 'B', len(grupo_b))

def junta(obs, nome):
    for o in obs: aplica_modificadores(o)
    bpy.ops.object.select_all(action='DESELECT')
    for o in obs:
        mw = o.matrix_world.copy(); o.parent = None; o.matrix_world = mw
        o.select_set(True)
    bpy.context.view_layer.objects.active = obs[0]
    bpy.ops.object.join()
    j = bpy.context.view_layer.objects.active; j.name = nome
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    if 'UVMap' not in j.data.uv_layers: j.data.uv_layers.new(name='UVMap')
    j.data.uv_layers['UVMap'].active_render = True
    # todas as câmeras do site têm o mesmo ângulo: faces viradas para trás nunca aparecem
    # (fundo da laje, costas de móveis); saem antes do UV para o atlas não gastar texel nelas.
    # Folhas são de face dupla e ficam.
    bm = bmesh.new(); bm.from_mesh(j.data)
    folha = {i for i, m in enumerate(j.data.materials) if m and m.name.startswith('folha')}
    costas = [f for f in bm.faces if f.material_index not in folha and f.normal.dot(PARA_CAMERA) < -.12]
    bmesh.ops.delete(bm, geom=costas, context='FACES')
    bm.to_mesh(j.data); bm.free()
    log('faces de costas removidas', nome, len(costas))
    uv = j.data.uv_layers.new(name='assado'); j.data.uv_layers.active = uv
    bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=.002, area_weight=0.0, correct_aspect=True, scale_to_bounds=False)
    bpy.ops.uv.pack_islands(udim_source='CLOSEST_UDIM', rotate=True, margin_method='FRACTION', margin=.0015, shape_method='CONCAVE')
    bpy.ops.object.mode_set(mode='OBJECT')
    return j
A = junta(grupo_a, 'assado-a')
B = junta(grupo_b, 'assado-b')
log('juntos', 'A tris', sum(len(p.vertices) - 2 for p in A.data.polygons), 'B tris', sum(len(p.vertices) - 2 for p in B.data.polygons))

RES = 2048
caminhos = {k: os.path.join(SAIDA, 'assado-%s.png' % k) for k in ('a', 'b')}
if FAZ_BAKE:
    cena.render.engine = 'CYCLES'
    pref = bpy.context.preferences.addons['cycles'].preferences
    pref.compute_device_type = 'OPTIX'; pref.refresh_devices()
    for d in pref.devices: d.use = d.type == 'OPTIX'
    cena.cycles.device = 'GPU'
    cena.cycles.samples = int(os.environ.get('AMOSTRAS', 384)); cena.cycles.use_denoising = False
    cena.render.bake.margin = 8; cena.render.bake.use_clear = True
    # os cabos só acendem na rolagem: não podem deixar sombra assada no piso da Tela 1
    cabos_obs = [O['cabo-' + k] for k in ('fiscal', 'auditor', 'vaga')]
    for o in cabos_obs: o.hide_render = True
    for chave, alvo in (('a', A), ('b', B)):
        img = bpy.data.images.new('bake-' + chave, RES, RES, float_buffer=True)
        for m in alvo.data.materials:
            if not m: continue
            nt = m.node_tree
            nd = nt.nodes.get('alvo-bake') or nt.nodes.new('ShaderNodeTexImage'); nd.name = 'alvo-bake'
            nd.image = img; nt.nodes.active = nd
        bpy.ops.object.select_all(action='DESELECT'); alvo.select_set(True); bpy.context.view_layer.objects.active = alvo
        t = time.time()
        bpy.ops.object.bake(type='COMBINED', pass_filter={'DIRECT', 'INDIRECT', 'DIFFUSE', 'TRANSMISSION', 'EMIT'}, margin=8, use_clear=True)
        img.save_render(caminhos[chave], scene=cena)       # aplica o tone mapping da prévia (Khronos PBR Neutral)
        log('bake', chave, round(time.time() - t, 1), 's')
    for o in cabos_obs: o.hide_render = False
# material de export: só o atlas assado, no UV 'assado' (vira TEXCOORD_0)
for chave, alvo in (('a', A), ('b', B)):
    m = bpy.data.materials.new('assado-' + chave); pb = principled(m); nt = m.node_tree
    tx = nt.nodes.new('ShaderNodeTexImage'); tx.image = bpy.data.images.load(caminhos[chave], check_existing=False)
    tx.image.name = 'assado-' + chave
    nt.links.new(tx.outputs['Color'], pb.inputs['Base Color'])
    pb.inputs['Roughness'].default_value = 1; pb.inputs['Specular IOR Level'].default_value = 0
    alvo.data.materials.clear(); alvo.data.materials.append(m)
    for nome in [u.name for u in alvo.data.uv_layers if u.name != 'assado']:
        alvo.data.uv_layers.remove(alvo.data.uv_layers[nome])
    alvo.data.uv_layers['assado'].name = 'UVMap'
    for at in [a.name for a in alvo.data.color_attributes]: alvo.data.color_attributes.remove(alvo.data.color_attributes[at])
    alvo['assado'] = 1
log('materiais assados ok')

# ───────────── 6. caixas de toque, export e otimização ─────────────
for id_ in ('fiscal', 'auditor', 'vaga'):
    bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1)
    bmesh.ops.scale(bm, vec=V(2.3, 1.8, 1.6), verts=bm.verts)
    bmesh.ops.translate(bm, vec=V(0, .35, .8), verts=bm.verts)
    me = bpy.data.meshes.new('toque-mesa-' + id_); bm.to_mesh(me); bm.free()
    cx = bpy.data.objects.new('toque-mesa-' + id_, me); cena.collection.objects.link(cx)
    mesa = O['mesa-' + id_]; cx.parent = mesa; cx.matrix_parent_inverse = Matrix(); cx['toque'] = 1
for o in [o for o in O if o.type == 'LIGHT']: bpy.data.objects.remove(o, do_unlink=True)
cena.render.resolution_x, cena.render.resolution_y = 750, 1040
cena.frame_set(1)
BRUTO = os.path.join(SAIDA, 'escritorio-bruto.glb')
bpy.ops.export_scene.gltf(
    filepath=BRUTO, export_format='GLB', use_selection=False, export_cameras=True, export_lights=False,
    export_extras=True, export_yup=True, export_apply=True, export_texcoords=True, export_normals=True,
    export_animations=True, export_animation_mode='ACTIONS', export_force_sampling=True, export_frame_range=True,
    export_def_bones=False, export_optimize_animation_size=True, export_vertex_color='MATERIAL',
    export_image_format='AUTO', export_materials='EXPORT')
log('glb bruto', round(os.path.getsize(BRUTO) / 1e6, 2), 'MB')
FINAL = os.path.join(RAIZ, 'agentes', 'escritorio', 'escritorio.glb')
# passos separados (e não `optimize`): o optimize poda os marcadores vazios, junta os cabos e
# funde os materiais numa paleta, e o site precisa dos nomes exatos
GT = 'npx --yes @gltf-transform/cli'
tmp1, tmp2, tmp3 = (os.path.join(SAIDA, 'passo-%d.glb' % k) for k in (1, 2, 3))
for cmd in ['%s dedup "%s" "%s"' % (GT, BRUTO, tmp1),
            '%s resize "%s" "%s" --width 2048 --height 2048' % (GT, tmp1, tmp2),
            '%s webp "%s" "%s" --quality 86' % (GT, tmp2, tmp3),
            '%s meshopt "%s" "%s" --level medium' % (GT, tmp3, FINAL)]:
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    log('gltf-transform', cmd.split()[3], r.returncode, (r.stdout + r.stderr).strip()[-300:])
    if r.returncode: raise SystemExit('gltf-transform falhou')
for t in (tmp1, tmp2, tmp3): os.remove(t)
log('glb final', round(os.path.getsize(FINAL) / 1e6, 2), 'MB')
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(SAIDA, 'escritorio-exportado.blend'), compress=True)
