"""Escritório nó · cena no Blender para aprovação (Rodada 3: R1, R3, R4, R5, R7)

Reprodutível, em dois passos, a partir da raiz da worktree:
    node .tasks/blender/gerar_texturas.cjs
    "C:/Program Files/Blender Foundation/Blender 5.2/blender.exe" -b -P .tasks/blender/construir_escritorio.py
    (acrescente  -- --sem-render  para só gerar o .blend)

Gera .tasks/blender/escritorio.blend e as prévias .tasks/blender/previa-<camera>.png.
Coordenadas do Blender: X para a direita, Y para o fundo, Z para cima. A câmera olha do
lado -X/-Y, quase de frente (azimute -18°, elevação 35°), como a Tela 1 da referência.
As pessoas olham para -Y (para a câmera); a esquerda delas é +X.
Composição, medidas e disposição vêm de agentes/escritorio/cena*.js (three.js, Y para cima):
(x, y, z) no three vira (x, -z, y) aqui.
Só as duas pessoas, móveis, plantas e objetos de trabalho: nada além disso.
"""
import bpy, bmesh, math, os, sys, json
from mathutils import Vector, Matrix, Euler, Quaternion

AQUI = os.path.dirname(os.path.abspath(__file__))
TEX = os.path.join(AQUI, 'texturas')
ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
PI = math.pi
V = lambda x=0, y=0, z=0: Vector((x, y, z))

bpy.ops.wm.read_factory_settings(use_empty=True)
cena = bpy.context.scene
FPS = 24
cena.render.fps = FPS
LACO = 192                                    # 8 s: todos os ciclos dividem o laço
cena.frame_start, cena.frame_end = 1, LACO

with open(os.path.join(TEX, 'cores.json'), encoding='utf8') as f:
    MARCA = json.load(f)

# ───────────────────────── cor e material ─────────────────────────
def lin(h):
    """hex sRGB → RGBA linear (o que o Principled espera)"""
    h = h.lstrip('#') if isinstance(h, str) else '%06x' % h
    out = []
    for i in (0, 2, 4):
        c = int(h[i:i + 2], 16) / 255
        out.append(c / 12.92 if c <= .04045 else ((c + .055) / 1.055) ** 2.4)
    return (*out, 1.0)

def mistura(a, b, t):
    ca, cb = lin(a), lin(b)
    return tuple(ca[i] + (cb[i] - ca[i]) * t for i in range(3)) + (1.0,)

_mats = {}
def material(nome, cor, rough=.8, metal=0.0, sheen=0.0, emissao=None, forca=0.0, imagem=None,
             alfa=None, sss=0.0, transmissao=0.0, sem_luz=False):
    if nome in _mats:
        return _mats[nome]
    m = bpy.data.materials.new(nome)
    m.use_nodes = True
    nt = m.node_tree
    p = nt.nodes['Principled BSDF']
    cor_lin = cor if isinstance(cor, tuple) else lin(cor)
    p.inputs['Base Color'].default_value = cor_lin
    p.inputs['Roughness'].default_value = rough
    p.inputs['Metallic'].default_value = metal
    if sheen:
        p.inputs['Sheen Weight'].default_value = sheen
        p.inputs['Sheen Roughness'].default_value = .5
    if sss:
        p.inputs['Subsurface Weight'].default_value = sss
        p.inputs['Subsurface Radius'].default_value = (.12, .05, .03)
        p.inputs['Subsurface Scale'].default_value = .04
    if transmissao:
        p.inputs['Transmission Weight'].default_value = transmissao
    if emissao is not None:
        p.inputs['Emission Color'].default_value = emissao if isinstance(emissao, tuple) else lin(emissao)
        p.inputs['Emission Strength'].default_value = forca
    if imagem:
        img = bpy.data.images.load(os.path.join(TEX, imagem), check_existing=True)
        tx = nt.nodes.new('ShaderNodeTexImage'); tx.image = img
        tx.extension = 'CLIP'
        if sem_luz:
            # textura chapada (logo, placa, chips): emissão pura, sem sombra
            nt.nodes.remove(p)
            em = nt.nodes.new('ShaderNodeEmission'); tr = nt.nodes.new('ShaderNodeBsdfTransparent')
            mx = nt.nodes.new('ShaderNodeMixShader')
            nt.links.new(tx.outputs['Color'], em.inputs['Color'])
            nt.links.new(tx.outputs['Alpha'], mx.inputs['Fac'])
            nt.links.new(tr.outputs[0], mx.inputs[1]); nt.links.new(em.outputs[0], mx.inputs[2])
            nt.links.new(mx.outputs[0], nt.nodes['Material Output'].inputs['Surface'])
        else:
            nt.links.new(tx.outputs['Color'], p.inputs['Base Color'])
            nt.links.new(tx.outputs['Alpha'], p.inputs['Alpha'])
            if emissao is not None:
                nt.links.new(tx.outputs['Color'], p.inputs['Emission Color'])
    if alfa is not None:
        p.inputs['Alpha'].default_value = alfa
    if alfa is not None or imagem:
        try:
            m.surface_render_method = 'BLENDED' if alfa is not None else 'DITHERED'
        except AttributeError:
            m.blend_method = 'BLEND'
    m.diffuse_color = cor_lin
    _mats[nome] = m
    return m

# ───────────────────────── coleções ─────────────────────────
def colecao(nome, pai=None):
    c = bpy.data.collections.new(nome)
    (pai or cena.collection).children.link(c)
    return c
COL = {k: colecao(v) for k, v in [('esc', 'Escritorio'), ('pes', 'Pessoas'), ('sala', 'Sala tech stack'),
                                    ('lin', 'Linhas azuis'), ('eti', 'Etiquetas (previa)'), ('cam', 'Cameras'), ('luz', 'Luzes')]}

# ───────────────────────── geometria (bmesh) ─────────────────────────
def bm_esfera(seg=24, aneis=16):
    bm = bmesh.new(); bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=aneis, radius=1, calc_uvs=True); return bm
def bm_cilindro(r1, r2, h, seg=24):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=seg, radius1=r1, radius2=r2, depth=h, calc_uvs=True)
    bmesh.ops.translate(bm, vec=V(0, 0, h / 2), verts=bm.verts)
    return bm
def bm_caixa(w, d, h, r=0.0, seg=2):
    bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1, calc_uvs=True)
    bmesh.ops.scale(bm, vec=V(w, d, h), verts=bm.verts)
    bmesh.ops.translate(bm, vec=V(0, 0, h / 2), verts=bm.verts)
    if r > 0:
        r = min(r, w / 2 - 1e-4, d / 2 - 1e-4, h / 2 - 1e-4)
        bmesh.ops.bevel(bm, geom=list(bm.edges) + list(bm.verts), offset=r, segments=seg, profile=.5, affect='EDGES', clamp_overlap=True)
    return bm
def bm_torno(perfil, seg=28):
    """sólido de revolução em torno de Z; perfil = [(raio, z), ...] de baixo para cima"""
    bm = bmesh.new(); aneis = []
    for r, z in perfil:
        if r <= 1e-5:
            aneis.append([bm.verts.new((0, 0, z))])
        else:
            aneis.append([bm.verts.new((r * math.cos(2 * PI * i / seg), r * math.sin(2 * PI * i / seg), z)) for i in range(seg)])
    for a, b in zip(aneis, aneis[1:]):
        if len(a) == 1 and len(b) == 1: continue
        if len(a) == 1:
            for i in range(seg): bm.faces.new((a[0], b[i], b[(i + 1) % seg]))
        elif len(b) == 1:
            for i in range(seg): bm.faces.new((a[i], a[(i + 1) % seg], b[0]))
        else:
            for i in range(seg): bm.faces.new((a[i], a[(i + 1) % seg], b[(i + 1) % seg], b[i]))
    if len(aneis[0]) > 1: bm.faces.new(list(reversed(aneis[0])))
    if len(aneis[-1]) > 1: bm.faces.new(aneis[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm
def bm_capsula(r, comp, seg=20, aneis=8):
    perfil = [(0, -comp / 2 - r)]
    for i in range(1, aneis + 1):
        a = -PI / 2 + PI / 2 * i / aneis
        perfil.append((r * math.cos(a), -comp / 2 + r * math.sin(a)))
    for i in range(0, aneis):
        a = PI / 2 * i / aneis
        perfil.append((r * math.cos(a), comp / 2 + r * math.sin(a)))
    perfil.append((0, comp / 2 + r))
    return bm_torno(perfil, seg)
def bm_toro(R, r, seg=24, sseg=10, arco=2 * PI):
    bm = bmesh.new(); n = seg + (0 if arco >= 2 * PI - 1e-6 else 1)
    aneis = []
    for i in range(n):
        a = arco * i / seg
        c = V(R * math.cos(a), R * math.sin(a), 0)
        aneis.append([bm.verts.new(c + (V(math.cos(a), math.sin(a), 0) * math.cos(2 * PI * j / sseg) + V(0, 0, 1) * math.sin(2 * PI * j / sseg)) * r) for j in range(sseg)])
    pares = list(zip(aneis, aneis[1:])) + ([(aneis[-1], aneis[0])] if n == seg else [])
    for a, b in pares:
        for j in range(sseg): bm.faces.new((a[j], b[j], b[(j + 1) % sseg], a[(j + 1) % sseg]))
    return bm
def bm_tubo(pontos, r, sseg=8):
    """tubo por uma polilinha suave (cordões, linhas)"""
    bm = bmesh.new(); aneis = []
    for i, p in enumerate(pontos):
        t = (pontos[min(i + 1, len(pontos) - 1)] - pontos[max(i - 1, 0)]).normalized()
        a = t.orthogonal().normalized(); b = t.cross(a)
        aneis.append([bm.verts.new(p + (a * math.cos(2 * PI * j / sseg) + b * math.sin(2 * PI * j / sseg)) * r) for j in range(sseg)])
    for a, b in zip(aneis, aneis[1:]):
        for j in range(sseg): bm.faces.new((a[j], b[j], b[(j + 1) % sseg], a[(j + 1) % sseg]))
    return bm
def bm_placa_arred(w, d, r, h, seg=10):
    """retângulo de cantos bem redondos extrudado em Z (tampo, balcão), base em z = 0"""
    bm = bmesh.new(); pts = []
    r = min(r, w / 2 - 1e-4, d / 2 - 1e-4)
    for cx, cy, a0 in [(w / 2 - r, -d / 2 + r, -PI / 2), (w / 2 - r, d / 2 - r, 0), (-w / 2 + r, d / 2 - r, PI / 2), (-w / 2 + r, -d / 2 + r, PI)]:
        for i in range(seg + 1):
            a = a0 + PI / 2 * i / seg
            pts.append(bm.verts.new((cx + r * math.cos(a), cy + r * math.sin(a), 0)))
    f = bm.faces.new(pts)
    ext = bmesh.ops.extrude_face_region(bm, geom=[f])
    bmesh.ops.translate(bm, vec=V(0, 0, h), verts=[v for v in ext['geom'] if isinstance(v, bmesh.types.BMVert)])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm
def bm_folha(comp, larg, curva, dobra=.3, ponta=.7, nu=4, nv=10):
    """folha larga oval: grade dobrada na nervura e curvada para fora; nasce em z = 0, cresce em +Y"""
    bm = bmesh.new(); grade = []
    for j in range(nv + 1):
        v = j / nv
        w = math.sin(PI * v ** ponta) ** .8
        linha = []
        for i in range(nu + 1):
            u = i / nu - .5
            x = u * larg * w
            linha.append(bm.verts.new((x, v * comp, curva * comp * v * v + abs(u) * larg * dobra * w)))
        grade.append(linha)
    for j in range(nv):
        for i in range(nu):
            bm.faces.new((grade[j][i], grade[j][i + 1], grade[j + 1][i + 1], grade[j + 1][i]))
    return bm

def transforma(bm, loc=(0, 0, 0), rot=(0, 0, 0), esc=(1, 1, 1), ordem='XYZ'):
    M = Matrix.Translation(V(*loc)) @ Euler(rot, ordem).to_matrix().to_4x4() @ Matrix.Diagonal((*esc, 1))
    bmesh.ops.transform(bm, matrix=M, verts=bm.verts)
    return bm

class Peca:
    """junta várias peças de bmesh, cada uma com o seu material, num objeto só"""
    def __init__(s):
        s.bm = bmesh.new(); s.mats = []
    def add(s, bm, mat, loc=(0, 0, 0), rot=(0, 0, 0), esc=(1, 1, 1), ordem='XYZ', liso=True):
        transforma(bm, loc, rot, esc, ordem)
        if mat not in s.mats: s.mats.append(mat)
        idx = s.mats.index(mat)
        for f in bm.faces:
            f.material_index = idx; f.smooth = liso
        me = bpy.data.meshes.new('tmp'); bm.to_mesh(me); bm.free()
        s.bm.from_mesh(me); bpy.data.meshes.remove(me)
        return s
    def objeto(s, nome, col, pai=None, loc=(0, 0, 0), rot=(0, 0, 0), esc=(1, 1, 1)):
        me = bpy.data.meshes.new(nome); s.bm.to_mesh(me); s.bm.free()
        for m in s.mats: me.materials.append(m)
        return objeto(nome, me, col, pai, loc, rot, esc)

def objeto(nome, dados, col, pai=None, loc=(0, 0, 0), rot=(0, 0, 0), esc=(1, 1, 1)):
    o = bpy.data.objects.new(nome, dados)
    col.objects.link(o)
    if pai is not None: o.parent = pai
    o.location = loc; o.rotation_euler = rot; o.scale = esc
    return o
def vazio(nome, col, pai=None, loc=(0, 0, 0), rot=(0, 0, 0)):
    o = objeto(nome, None, col, pai, loc, rot); o.empty_display_size = .08
    return o
def malha(nome, bm, mat, col, pai=None, loc=(0, 0, 0), rot=(0, 0, 0), esc=(1, 1, 1), liso=True):
    return Peca().add(bm, mat, liso=liso).objeto(nome, col, pai, loc, rot, esc)
def caixa(nome, w, d, h, r, mat, col, pai=None, loc=(0, 0, 0), rot=(0, 0, 0)):
    """bloco arredondado com bevel e normais endurecidas (faces planas limpas)"""
    bm = bm_caixa(w, d, h)
    me = bpy.data.meshes.new(nome); bm.to_mesh(me); bm.free()
    me.materials.append(mat)
    for p in me.polygons: p.use_smooth = True
    o = objeto(nome, me, col, pai, loc, rot)
    if r > 0:
        b = o.modifiers.new('arredonda', 'BEVEL')
        b.width = min(r, w / 2 - 1e-3, d / 2 - 1e-3, h / 2 - 1e-3); b.segments = 3; b.harden_normals = True; b.limit_method = 'NONE'
    return o
def plano_imagem(nome, w, h, mat, col, pai=None, loc=(0, 0, 0), rot=(0, 0, 0)):
    bm = bmesh.new(); bm.loops.layers.uv.new('UVMap')
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=.5, calc_uvs=True)
    bmesh.ops.scale(bm, vec=V(w, h, 1), verts=bm.verts)
    me = bpy.data.meshes.new(nome); bm.to_mesh(me); bm.free(); me.materials.append(mat)
    return objeto(nome, me, col, pai, loc, rot)

# ───────────────────────── câmera e composição ─────────────────────────
ELEV, AZ = math.radians(35), math.radians(-18)
DIR_CAM = V(math.sin(AZ) * math.cos(ELEV), -math.cos(AZ) * math.cos(ELEV), math.sin(ELEV)).normalized()   # para a câmera
DIREITA = V(math.cos(AZ), math.sin(AZ), 0)
CIMA = DIREITA.cross(-DIR_CAM).normalized() * -1
if CIMA.z < 0: CIMA = -CIMA
def na_tela(sx, sy, z=0.0):
    """ponto do mundo na altura z que cai em (sx, sy) do plano da tela (unidades de mundo)"""
    r, u = DIREITA, CIMA
    b = sy - u.z * z
    det = r.x * u.y - r.y * u.x
    return V((sx * u.y - r.y * b) / det, (r.x * b - u.x * sx) / det, z)
def tela_de(p):
    return (p.dot(DIREITA), p.dot(CIMA))
K1 = .86
def T1(sx, sy, z=0.0):
    """composição da Tela 1 (a mesma da cena three.js): desenhada num quadro de 5,6 e apertada"""
    return na_tela(sx * K1, .2 + (sy - .2) * K1, z) if sx < 3 else na_tela(sx, sy, z)

# ───────────────────────── materiais da cena ─────────────────────────
M = {
    'piso': material('piso', '#DCCBB3', rough=.92),
    'parede': material('parede', '#EDE3D3', rough=.9),
    'rodape': material('rodape', '#D2BFA2', rough=.7),
    'base': material('branco-quente', '#F1E8DA', rough=.55),
    'madeira': material('carvalho', '#D7B07A', rough=.5),
    'madeira_escura': material('carvalho-escuro', '#B38A5C', rough=.55),
    'tecido': material('tecido-creme', '#E6D8C2', rough=.95, sheen=.4),
    'tecido_cinza': material('tecido-cinza', '#BFB4A4', rough=.95, sheen=.4),
    'tapete': material('tapete', '#8F877C', rough=1.0),
    'preto': material('preto-fosco', '#1C1B1A', rough=.42, metal=.2),
    'grafite': material('grafite', '#34322F', rough=.5, metal=.2),
    'metal': material('metal', '#B9B6B0', rough=.3, metal=.8),
    'ceramica': material('ceramica-branca', '#F2EDE5', rough=.3),
    'terracota': material('terracota', '#C3835A', rough=.55),
    'salvia': material('ceramica-salvia', '#B2BEA6', rough=.35),
    'terra': material('terra', '#3E2C20', rough=1.0),
    'folha': material('folha', '#4F7F3E', rough=.42, sss=.15),
    'folha_clara': material('folha-clara', '#6E9A52', rough=.42, sss=.15),
    'folha_escura': material('folha-escura', '#3C6531', rough=.42, sss=.15),
    'papel': material('papel', '#FBF8F1', rough=.9),
    'livro_capa': material('livro-capa', '#2F3B52', rough=.7),
    'cafe': material('cafe', '#3A2416', rough=.15),
    'lampada': material('lampada', '#FFF2D6', rough=.4, emissao='#FFDDA8', forca=6),
    'vidro': material('vidro', '#DCE7F2', rough=.04, alfa=.16),
    'janela': material('vidro-janela', '#EAF1F7', rough=.1, emissao='#F6F2EA', forca=1.2),
    'caixilho': material('caixilho', '#151515', rough=.35, metal=.3),
    'azul': material('azul-linha', MARCA['azul'], rough=.3, emissao=MARCA['azul'], forca=1.2),
    'tela': [material('tela-%d' % k, '#EEF2FA', rough=.25, emissao='#FFFFFF', forca=1.1, imagem='tela-%d.png' % k) for k in range(3)],
    'teclado': material('teclado', '#2B2A28', rough=.6, imagem='teclado.png'),
    'livros': material('lombadas', '#E9DFCF', rough=.8, imagem='livros.png'),
    'rack': material('rack-frente', '#161616', rough=.45, metal=.2, imagem='rack.png'),
    'logo': material('logo-balcao', '#141414', imagem='logo.png', sem_luz=True),
    'placa': material('placa-lockup', '#FFFFFF', imagem='placa.png', sem_luz=True),
}
for m in M['tela']:
    m.node_tree.nodes['Image Texture'].extension = 'EXTEND'

# ───────────────────────── plantas ─────────────────────────
def planta(nome, tipo, esc, semente, vaso='ceramica', col=None, pai=None, loc=(0, 0, 0)):
    import random
    rnd = random.Random(semente)
    col = col or COL['esc']
    g = vazio(nome, col, pai, loc)
    rv, hv = {'espada': (.15, .3), 'suculenta': (.085, .09), 'arbusto': (.2, .3)}.get(tipo, (.18, .27))
    perfil = [(0, 0), (rv * .7, 0), (rv * .8, .02), (rv, hv * .4), (rv * .98, hv * .92), (rv * 1.04, hv), (rv * .9, hv), (rv * .86, hv * .9), (0, hv * .9)]
    p = Peca().add(bm_torno(perfil, 32), M[vaso]).add(bm_cilindro(rv * .86, rv * .86, .006, 24), M['terra'], loc=(0, 0, hv * .88))
    topo = hv * .9
    verdes = [M['folha'], M['folha_clara'], M['folha_escura']]
    if tipo == 'espada':
        for i in range(9):
            a = i * 2.4 + rnd.random(); d = .02 + rnd.random() * .06
            p.add(bm_folha(.55 + rnd.random() * .35, .08 + rnd.random() * .03, .04, .25, .95), verdes[i % 3],
                  loc=(math.cos(a) * d, math.sin(a) * d, topo), rot=(PI / 2 - .08 - rnd.random() * .15, 0, a), ordem='XZY')
    elif tipo == 'suculenta':
        for i in range(11):
            a = i * 2.4; cam = 0 if i < 6 else 1
            p.add(bm_folha(.085 - cam * .025, .05, .5, .3, .7, 3, 6), verdes[i % 3],
                  loc=(0, 0, topo), rot=(PI / 2 - (.9 - cam * .45), 0, a), ordem='XZY')
    elif tipo == 'arbusto':
        for i in range(13):
            a = i * 2.4 + rnd.random(); d = .04 + rnd.random() * .14; s = .1 + rnd.random() * .07
            p.add(bm_esfera(14, 10), verdes[i % 3], loc=(math.cos(a) * d, math.sin(a) * d, topo + .12 + rnd.random() * .34), esc=(s, s, s))
    else:
        # folhagem de folhas largas (como a referência): talos que sobem e se abrem, folha oval brilhante na ponta
        n = 17
        for i in range(n):
            a = i * 2.4 + rnd.random() * .4
            inc = .15 + (i / n) * 1.0 + rnd.random() * .15
            alt = .14 + (1 - i / n) * .28 + rnd.random() * .1
            base = V(math.cos(a) * .015, math.sin(a) * .015, topo)
            dirc = V(math.cos(a) * math.sin(inc), math.sin(a) * math.sin(inc), math.cos(inc))
            ponta = base + dirc * alt
            p.add(bm_tubo([base, base + dirc * alt * .5 + V(0, 0, .03), ponta], .007, 5), M['folha_escura'])
            p.add(bm_folha(.2 + rnd.random() * .08, .14 + rnd.random() * .03, .16, .22, .6, 4, 8), verdes[i % 3],
                  loc=tuple(ponta), rot=(PI / 2 - inc - .35, 0, a - PI / 2), ordem='XYZ')
    o = p.objeto(nome + '-malha', col, g, esc=(esc, esc, esc))
    return g

# ───────────────────────── objetos de mesa ─────────────────────────
def monitor(nome, col, pai, loc, rot_z, larg=.58, alt=.37, k=0):
    """a tela olha para +Y local (para quem senta, atrás da mesa); a câmera vê as costas pretas"""
    g = vazio(nome, col, pai, loc, (0, 0, rot_z))
    p = Peca()
    p.add(bm_caixa(.26, .19, .018, .008), M['preto'])
    p.add(bm_caixa(.05, .028, .27, .012), M['preto'], loc=(0, -.045, .01), rot=(.08, 0, 0))
    p.add(bm_caixa(larg, .032, alt, .014), M['preto'], loc=(0, 0, .2))
    p.add(bm_caixa(larg * .5, .04, alt * .55, .02), M['preto'], loc=(0, -.02, .2 + alt * .2))
    p.objeto(nome + '-corpo', col, g)
    tl = plano_imagem(nome + '-tela', larg - .035, alt - .035, M['tela'][k % 3], col, g, (0, .0175, .2 + alt / 2), (PI / 2, 0, PI))
    return g
def teclado(col, pai, loc):
    g = malha('teclado', bm_caixa(.42, .14, .02, .008), M['grafite'], col, pai, loc)
    plano_imagem('teclado-teclas', .4, .125, M['teclado'], col, g, (0, 0, .0205), (0, 0, PI))
    return g
def mouse(col, pai, loc):
    p = Peca().add(bm_caixa(.2, .17, .004, .002), M['grafite'])
    bm = bm_esfera(16, 10); bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.co.z < -1e-4], context='VERTS')
    p.add(bm, M['ceramica'], loc=(0, 0, .004), esc=(.033, .05, .022))
    return p.objeto('mouse', col, pai, loc)
def caneca(nome, col, pai, loc, mat=None):
    perfil = [(0, 0), (.044, 0), (.05, .01), (.052, .1), (.047, .1), (.045, .02), (0, .02)]
    p = Peca().add(bm_torno(perfil, 24), mat or M['ceramica'])
    p.add(bm_cilindro(.045, .045, .004, 18), M['cafe'], loc=(0, 0, .082))
    p.add(bm_toro(.028, .009, 14, 8, PI * 1.3), mat or M['ceramica'], loc=(.052, 0, .052), rot=(PI / 2, -PI * .65 + PI, 0))
    return p.objeto(nome, col, pai, loc)
def luminaria(col, pai, loc, rot_z=0):
    g = vazio('luminaria', col, pai, loc, (0, 0, rot_z))
    p = Peca()
    p.add(bm_cilindro(.085, .095, .025, 24), M['preto'])
    p.add(bm_cilindro(.011, .011, .36, 8), M['preto'], loc=(0, 0, .02), rot=(0, -.28, 0))
    p.add(bm_esfera(10, 8), M['preto'], loc=(-.098, 0, .36), esc=(.022, .022, .022))
    p.add(bm_cilindro(.011, .011, .3, 8), M['preto'], loc=(-.098, 0, .36), rot=(0, 1.25, 0))
    cup = bm_esfera(20, 12); bmesh.ops.delete(bm, geom=[], context='VERTS') if False else None
    bmesh.ops.delete(cup, geom=[v for v in cup.verts if v.co.z < -1e-4], context='VERTS')
    p.add(cup, M['preto'], loc=(.19, 0, .45), rot=(0, 2.35, 0), esc=(.1, .1, .115))
    p.add(bm_esfera(12, 8), M['lampada'], loc=(.19 + .02 * math.sin(2.35), 0, .45 + .02 * math.cos(2.35)), esc=(.04, .04, .04))
    p.objeto('luminaria-malha', col, g)
    return g
def papeis(col, pai, loc, n=3, rot_z=0):
    p = Peca()
    for i in range(n):
        p.add(bm_caixa(.21, .29, .004, .001, 1), M['papel'], loc=((i % 2) * .01, -(i % 3) * .008, i * .004), rot=(0, 0, (i - 1) * .12))
    return p.objeto('papeis', col, pai, loc, (0, 0, rot_z))
def pilha_livros(col, pai, loc, cores, rot_z=0):
    p = Peca(); z = 0
    for i, c in enumerate(cores):
        h = .04 + (i % 2) * .012
        p.add(bm_caixa(.3 - i * .02, .22, h, .008, 1), material('livro-%s' % c, c, rough=.7), loc=(0, 0, z), rot=(0, 0, (i - 1) * .1))
        p.add(bm_caixa(.28 - i * .02, .21, h - .01, .002, 1), M['papel'], loc=(.008, 0, z + .005), rot=(0, 0, (i - 1) * .1))
        z += h
    return p.objeto('livros-mesa', col, pai, loc, (0, 0, rot_z))
def caixa_preta(col, pai, loc, rot_z=0):
    p = Peca().add(bm_caixa(.26, .17, .1, .02), M['preto'])
    p.add(bm_esfera(8, 6), material('led-verde', MARCA['verde'], emissao=MARCA['verde'], forca=4), loc=(.1, -.086, .06), esc=(.008, .008, .008))
    return p.objeto('roteador', col, pai, loc, (0, 0, rot_z))

def cadeira(nome, col, pai, loc, rot_z=0, estofado=None):
    estofado = estofado or M['tecido']
    g = vazio(nome, col, pai, loc, (0, 0, rot_z))
    p = Peca()
    for i in range(5):
        a = i * 2 * PI / 5 + .3
        p.add(bm_caixa(.05, .3, .035, .015, 1), M['grafite'], loc=(math.sin(a) * .13, math.cos(a) * .13, .04), rot=(0, 0, -a))
        p.add(bm_esfera(10, 8), M['preto'], loc=(math.sin(a) * .27, math.cos(a) * .27, .032), esc=(.026, .032, .032))
    p.add(bm_cilindro(.03, .03, .32, 12), M['metal'], loc=(0, 0, .06))
    p.add(bm_caixa(.3, .3, .04, .015, 1), M['grafite'], loc=(0, 0, .36))
    p.add(bm_caixa(.54, .52, .09, .04, 3), estofado, loc=(0, 0, .39))
    p.add(bm_caixa(.06, .04, .34, .015, 1), M['grafite'], loc=(0, .27, .4), rot=(.1, 0, 0))
    p.add(bm_caixa(.52, .09, .5, .045, 3), estofado, loc=(0, .29, .55), rot=(.12, 0, 0))
    for s in (-1, 1):
        p.add(bm_caixa(.035, .035, .2, .012, 1), M['grafite'], loc=(s * .27, .04, .43))
        p.add(bm_caixa(.06, .24, .03, .014, 1), M['grafite'], loc=(s * .27, .02, .62))
    p.objeto(nome + '-malha', col, g)
    return g

# ───────────────────────── mesa de trabalho ─────────────────────────
LARG, PROF, ALT = 2.2, 1.0, .72
ASSENTO = V(-.42, .74, 0)               # quem senta fica atrás da mesa (+Y), de frente para -Y
def mesa(id_, k, ocupada=True):
    col = COL['esc']
    g = vazio('mesa-' + id_, col)
    tampo = malha('tampo', bm_placa_arred(LARG, PROF, .16, .055, 8), M['madeira'], col, g, (0, 0, ALT - .055))
    b = tampo.modifiers.new('borda', 'BEVEL'); b.width = .012; b.segments = 2; b.harden_normals = True
    pw = LARG * .55; px = LARG / 2 - pw / 2 - .07
    caixa('pedestal', pw, PROF - .12, ALT - .06, .07, M['base'], col, g, (px, 0, .005))
    for x, y in [(-LARG / 2 + .12, -PROF / 2 + .12), (-LARG / 2 + .12, PROF / 2 - .12)]:
        malha('pe', bm_cilindro(.022, .018, ALT - .05, 12), M['base'], col, g, (x, y, 0))
    caixa('trave', .03, PROF - .26, .03, .01, M['base'], col, g, (-LARG / 2 + .12, 0, .12))
    A = ASSENTO
    dx, dy = A.x - (A.x + .5), A.y - (-.08)
    monitor('monitor', col, g, (A.x + .5, -.08, ALT), math.atan2(-dx, dy) * -1, k=k)
    teclado(col, g, (A.x, .27 - .0, ALT))
    cadeira('cadeira', col, g, (A.x, A.y + .07, 0), 0 if ocupada else -.22)
    if not ocupada:
        mouse(col, g, (A.x - .33, .3, ALT))
    marca = vazio('marca-mesa-' + id_, col, g, (0, 0, ALT))
    g['mesa'] = id_
    return g

# ───────────────────────── pessoa ─────────────────────────
R_CAB = .285
C_CAB = V(0, -.012, .305)               # centro da cabeça no pivô do pescoço
L1, L2 = .27, .29
OMBRO = V(.188, .005, .5)               # no pivô do tronco (lado esquerdo, +X)
PIVO_TRONCO = V(0, .05, .5)
PIVO_PESCOCO = V(0, 0, .625)
CAMISA = '#F7F5F0'

def cab(th, ph, fora=0.0):
    r = R_CAB + fora
    return C_CAB + V(r * math.sin(th) * math.cos(ph), -r * math.cos(th) * math.cos(ph), r * math.sin(ph))

def deforma_esfera(bm, corte, fn):
    """mantém só a calota de ângulo polar < corte e empurra cada vértice pela função fn(normal)"""
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if math.acos(max(-1, min(1, v.co.normalized().z))) > corte + 1e-3], context='VERTS')
    for v in bm.verts:
        n = v.co.normalized(); v.co = n * (v.co.length + fn(n))
    return bm

def pessoa(agente, pele, cabelo, estilo, calca, sapato, cor_cracha, fase, mesa_g):
    col = COL['pes']
    m_pele = material('pele-' + agente, pele, rough=.5, sss=.25)
    m_pele_esc = material('pele-escura-' + agente, mistura(pele, '#5A2E1E', .16), rough=.55)
    m_bochecha = material('bochecha-' + agente, mistura(pele, '#E07F72', .22), rough=.6)
    m_labio = material('labio-' + agente, mistura(pele, '#5C2420', .7), rough=.5)
    m_cab = material('cabelo-' + agente, cabelo, rough=.55, sheen=.3)
    m_cab2 = material('cabelo-claro-' + agente, mistura(cabelo, '#7A5A44', .25), rough=.55, sheen=.3)
    m_camisa = material('camisa', CAMISA, rough=.78, sheen=.7)
    m_camisa_s = material('camisa-dobra', '#E6E0D5', rough=.8, sheen=.5)
    m_calca = material('calca-' + agente, calca, rough=.85, sheen=.3)
    m_sapato = material('sapato-' + agente, sapato, rough=.5)
    m_sola = material('sola', '#EFEAE1', rough=.7)
    m_cor = material('cordao-' + agente, cor_cracha, rough=.5)
    m_card = material('cracha-' + agente, '#FFFFFF', rough=.4, imagem='cracha-%s.png' % agente)
    m_olho = material('olho', '#1A1412', rough=.12)
    m_brilho = material('brilho', '#FFFFFF', rough=.2, emissao='#FFFFFF', forca=2)
    m_cinto = material('cinto', '#4A3426', rough=.5)
    m_fivela = material('fivela', '#B8AE9C', rough=.3, metal=.7)
    m_botao = material('botao', '#D9D2C4', rough=.4)

    raiz = vazio('pessoa-' + agente, col, mesa_g, tuple(ASSENTO))
    raiz['agente'] = agente
    # pernas e quadril (sentado)
    p = Peca()
    p.add(bm_caixa(.38, .32, .16, .075, 2), m_calca, loc=(0, .04, .43))
    for s in (-1, 1):
        p.add(bm_capsula(.083, .3), m_calca, loc=(s * .098, -.15, .53), rot=(PI / 2, 0, 0))
        p.add(bm_capsula(.072, .3), m_calca, loc=(s * .1, -.36, .3), rot=(.06, 0, 0))
        p.add(bm_caixa(.115, .23, .085, .04, 2), m_sapato, loc=(s * .1, -.43, .02))
        p.add(bm_caixa(.125, .24, .024, .01, 1), m_sola, loc=(s * .1, -.432, 0))
    p.objeto('pernas-' + agente, col, raiz)

    tronco = vazio('tronco-' + agente, col, raiz, tuple(PIVO_TRONCO), (.1, 0, 0))
    # tronco: cápsula de camisa, ombros largos e peito raso
    Rc, Lc = .215, .22
    malha('corpo-' + agente, bm_capsula(Rc, Lc, 28, 10), m_camisa, col, tronco, (0, 0, Rc + Lc / 2), esc=(1.12, .84, 1))
    zf = -Rc * .84
    d = Peca()
    d.add(bm_cilindro(.066, .072, .13, 18), m_pele, loc=(0, 0, .55))
    d.add(bm_toro(.083, .021, 22, 8, PI * 1.42), m_camisa, loc=(0, .004, .612), rot=(.14, 0, PI / 2 + PI * .29), esc=(1, 1.08, 1))
    d.add(bm_cilindro(0, .044, .1, 3), m_pele, loc=(0, -.118, .54), rot=(PI - .62, 0, 0), esc=(1, .28, 1))
    for s in (-1, 1):
        d.add(bm_caixa(.07, .1, .014, .004, 1), m_camisa, loc=(s * .04, -.09, .59), rot=(-.95, s * .25, s * .45))
    d.add(bm_caixa(.03, .012, .3, .004, 1), m_camisa_s, loc=(0, zf + .003, .16))
    for z in (.22, .32, .42):
        d.add(bm_esfera(8, 6), m_botao, loc=(0, zf - .006, z), esc=(.009, .005, .009))
    d.add(bm_caixa(.075, .008, .08, .003, 1), m_camisa_s, loc=(.105, zf + .014, .37), rot=(0, 0, -.38))
    for i, (s, z) in enumerate([(-1, .1), (1, .13), (-1, .19)]):
        d.add(bm_capsula(.006, .07, 6, 3), m_camisa_s, loc=(s * (.1 + i * .015), zf + .02, z + .03), rot=(0, s * (1.0 + i * .2), -s * .5))
    d.add(bm_cilindro(.168, .16, .046, 28), m_cinto, loc=(0, 0, .045), esc=(1.12, .84, 1))
    d.add(bm_caixa(.05, .012, .036, .006, 1), m_fivela, loc=(0, -.16 * .84 - .004, .05))
    # cordão do crachá na cor do agente, do pescoço ao peito (R5)
    for s in (-1, 1):
        pts = [V(s * .07, .035, .6), V(s * .088, -.06, .565), V(s * .058, -.155, .47), V(s * .02, -.182, .4), V(s * .004, -.19, .37)]
        d.add(bm_tubo(suaviza(pts, 4), .008, 6), m_cor)
    d.objeto('camisa-' + agente, col, tronco)
    # crachá: cartão retangular com faixa na cor do agente e o "nó." (R5), num pivô que balança
    piv = vazio('pivo-cracha-' + agente, col, tronco, (0, -.19, .372))
    c = Peca()
    c.add(bm_caixa(.026, .012, .022, .004, 1), m_fivela, loc=(0, 0, -.022))
    c.add(bm_caixa(.118, .012, .166, .012, 2), material('cracha-borda-' + agente, cor_cracha, rough=.45), loc=(0, .002, -.19))
    c.objeto('cracha-' + agente, col, piv)
    plano_imagem('cracha-cartao-' + agente, .108, .152, m_card, col, piv, (0, -.0045, -.107), (PI / 2, 0, 0))

    pesc = vazio('pescoco-' + agente, col, tronco, tuple(PIVO_PESCOCO), (-.04, 0, .22))
    malha('cabeca-' + agente, bm_esfera(48, 32), m_pele, col, pesc, tuple(C_CAB), esc=(R_CAB, R_CAB * .98, R_CAB * .97))
    # rosto: orelhas, nariz, boca, sobrancelhas e bochechas
    r = Peca()
    for s in (-1, 1):
        x, y, z = s * (R_CAB - .006), C_CAB.y + .015, C_CAB.z - .05
        r.add(bm_esfera(14, 10), m_pele, loc=(x, y, z), rot=(0, s * .15, 0), esc=(.046, .056, .074))
        r.add(bm_esfera(10, 8), m_pele_esc, loc=(x + s * .02, y - .008, z), esc=(.018, .03, .04))
        sb = cab(s * .37, .24, .004)
        r.add(bm_capsula(.0125, .05, 8, 3), m_cab, loc=tuple(sb), rot=(0, PI / 2 + s * .12, s * .37), esc=(1, .6, 1), ordem='XYZ')
        bc = cab(s * .62, -.17, -.024)
        r.add(bm_esfera(12, 8), m_bochecha, loc=tuple(bc), rot=(0, 0, s * .62), esc=(.052, .03, .032))
    n = cab(0, -.07, -.008)
    r.add(bm_esfera(12, 8), m_pele_esc, loc=tuple(n), esc=(.03, .026, .024))
    b = cab(0, -.31, -.003)
    r.add(bm_toro(.036, .0085, 18, 6, PI), m_labio, loc=(b.x, b.y, b.z + .022), rot=(-PI / 2 + .3, 0, 0))   # arco para baixo: sorriso
    r.objeto('rosto-' + agente, col, pesc)
    # olhos com brilho; a origem fica na altura dos olhos, para piscar
    o = Peca()
    for s in (-1, 1):
        e = cab(s * .36, 0, -.004) - V(0, 0, C_CAB.z)
        o.add(bm_esfera(16, 12), m_olho, loc=tuple(e), rot=(0, 0, s * .36), esc=(.03, .018, .041))
        o.add(bm_esfera(8, 6), m_brilho, loc=(e.x - .009, e.y - .016, e.z + .014), esc=(.0095, .0095, .0095))
        o.add(bm_esfera(6, 4), m_brilho, loc=(e.x + .008, e.y - .016, e.z - .012), esc=(.0045, .0045, .0045))
    olhos = o.objeto('olhos-' + agente, col, pesc, (0, 0, C_CAB.z))
    # cabelo
    h = Peca()
    if estilo == 'crespo':
        def cacho(n_):
            a = 40
            return math.sin(n_.x * a) * math.sin(n_.y * a + 1.3) * math.sin(n_.z * a + .7)
        cal = deforma_esfera(bm_esfera(120, 60), PI * .53, lambda n_: R_CAB * .03 + .03 + .019 * cacho(n_) + .034 * max(0, n_.z) ** 1.5)
        bmesh.ops.scale(cal, vec=V(R_CAB, R_CAB, R_CAB), verts=[]) if False else None
        for v in cal.verts: v.co = v.co.normalized() * (R_CAB * 1.03 + (v.co.length - 1))
        h.add(cal, m_cab, loc=(C_CAB.x, C_CAB.y + .01, C_CAB.z + .006), rot=(-.6, 0, 0))
        for s in (-1, 1):
            pt = cab(s * 1.3, .1, .008)
            h.add(bm_esfera(10, 8), m_cab, loc=tuple(pt), rot=(0, 0, s * 1.3), esc=(.028, .04, .06))
    else:
        def mechas(n_):
            az = math.atan2(n_.x, -n_.y); pol = math.acos(max(-1, min(1, n_.z)))
            sulco = .011 * (1 - abs(math.sin(az * 9 + pol * 2.6))) + .005 * math.sin(az * 23)
            volume = .024 * max(0, n_.z)
            # franja penteada para o lado: o volume da frente cresce para +X e cai sobre a testa
            franja = .03 * math.exp(-((az - .35) / .7) ** 2) * math.exp(-((pol - 1.3) / .35) ** 2)
            return sulco + volume + franja
        cal = deforma_esfera(bm_esfera(72, 36), PI * .6, mechas)
        for v in cal.verts: v.co = v.co.normalized() * (R_CAB * 1.055 + (v.co.length - 1))
        h.add(cal, m_cab, loc=(C_CAB.x, C_CAB.y + .004, C_CAB.z + .006), rot=(-.66, 0, -.12))
        for s in (-1, 1):
            pt = cab(s * 1.36, .02, .006)
            h.add(bm_esfera(10, 8), m_cab, loc=tuple(pt), rot=(0, 0, s * 1.36), esc=(.032, .04, .075))
    h.objeto('cabelo-' + agente, col, pesc)

    # braços: ombro → cotovelo → punho, posados por IK de dois ossos até o teclado
    teclado_p = V(0, .27 - ASSENTO.y, ALT + .022)        # no espaço da pessoa
    bracos = []
    for s in (1, -1):
        Sm = tronco.matrix_basis.copy()
        S = (Matrix.Translation(PIVO_TRONCO) @ Euler((.1, 0, 0)).to_matrix().to_4x4()) @ V(OMBRO.x * s, OMBRO.y, OMBRO.z)
        T = teclado_p + V(s * .1, .085, .05)
        polo = V(s * .75, .5, -.4).normalized()
        E, W = ik(S, T, polo)
        ombro = vazio('ombro-%s-%s' % (agente, 'esq' if s > 0 else 'dir'), col, tronco, tuple(V(OMBRO.x * s, OMBRO.y, OMBRO.z)))
        mt = Euler((.1, 0, 0)).to_matrix()
        d1 = mt.inverted() @ (E - S).normalized()
        q1 = V(0, 0, -1).rotation_difference(d1)
        ombro.rotation_mode = 'QUATERNION'; ombro.rotation_quaternion = q1
        malha('braco', bm_capsula(.06, L1, 16, 6), m_camisa, col, ombro, (0, 0, -L1 / 2))
        cot = vazio('cotovelo', col, ombro, (0, 0, -L1))
        d2 = (mt @ q1.to_matrix()).inverted() @ (W - E).normalized()
        q2 = V(0, 0, -1).rotation_difference(d2)
        cot.rotation_mode = 'QUATERNION'; cot.rotation_quaternion = q2
        a = Peca()
        a.add(bm_capsula(.054, .13, 14, 5), m_camisa, loc=(0, 0, -.065))
        a.add(bm_toro(.056, .02, 16, 8), m_camisa_s, loc=(0, 0, -.15))
        a.add(bm_capsula(.04, L2 - .16, 12, 5), m_pele, loc=(0, 0, -.16 - (L2 - .16) / 2))
        a.objeto('antebraco', col, cot)
        pun = vazio('punho', col, cot, (0, 0, -L2))
        # mão: deitada sobre o teclado, dedos para a frente (-Y) e um pouco caídos
        mw = mt @ q1.to_matrix() @ q2.to_matrix()
        alvo_m = Euler((-.38, 0, 0)).to_matrix() @ Matrix(((1, 0, 0), (0, 0, -1), (0, 1, 0)))
        pun.rotation_mode = 'QUATERNION'; pun.rotation_quaternion = (mw.inverted() @ Euler((.38, 0, 0)).to_matrix()).to_quaternion()
        mm = Peca()
        mm.add(bm_esfera(14, 10), m_pele, loc=(0, -.045, -.004), esc=(.052, .06, .028))
        for x, l in [(-.03, .03), (-.01, .036), (.01, .034), (.029, .027)]:
            mm.add(bm_capsula(.0125, l, 8, 3), m_pele, loc=(x * s, -.1 - l / 2 + .015, -.016), rot=(PI / 2 - .5, 0, 0))
        mm.add(bm_capsula(.014, .03, 8, 3), m_pele, loc=(-s * .046, -.055, -.006), rot=(PI / 2 - .15, 0, s * .75), ordem='ZXY')
        mm.objeto('mao', col, pun)
        bracos.append((s, ombro, cot, pun))
    marca = vazio('marca-pessoa-' + agente, col, raiz, (0, -.05, 1.28))
    anima_pessoa(agente, tronco, pesc, olhos, piv, bracos, fase)
    return raiz

def suaviza(pts, n):
    """Catmull-Rom simples pelos pontos"""
    out = []
    P = [pts[0]] + pts + [pts[-1]]
    for i in range(1, len(P) - 2):
        p0, p1, p2, p3 = P[i - 1], P[i], P[i + 1], P[i + 2]
        for k in range(n):
            t = k / n
            out.append(.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t))
    out.append(pts[-1])
    return out

def ik(S, T, polo):
    d = T - S
    dist = min(max(d.length, abs(L1 - L2) + .01), L1 + L2 - .004)
    d.normalize()
    cosA = max(-1, min(1, (L1 * L1 + dist * dist - L2 * L2) / (2 * L1 * dist)))
    a = math.acos(cosA)
    p = (polo - d * polo.dot(d)).normalized()
    E = S + d * (L1 * math.cos(a)) + p * (L1 * math.sin(a))
    return E, S + d * dist

# ───────────────────────── animação de conferência ─────────────────────────
def chave(obj, prop, quadro, valor, idx=None):
    setattr(obj, prop, valor) if idx is None else getattr(obj, prop).__setitem__(idx, valor)
    obj.keyframe_insert(prop, index=-1 if idx is None else idx, frame=quadro)

def anima_pessoa(agente, tronco, pesc, olhos, piv, bracos, fase):
    """laço de 8 s: respiração, balanço do tronco, cabeça olhando a tela e o lado,
       piscar e digitação com mãos alternadas"""
    f0 = int(fase * FPS) % LACO
    rx0 = tronco.rotation_euler.x
    for q in range(0, LACO + 1, 6):
        t = q / FPS
        tronco.scale = (1 + .012 * math.sin(2 * PI * q / 72), 1 + .014 * math.sin(2 * PI * q / 72), 1 + .018 * math.sin(2 * PI * q / 72))
        tronco.keyframe_insert('scale', frame=q + 1)
        tronco.rotation_euler = (rx0 + .022 * math.sin(2 * PI * (q + f0) / 96), 0, .05 * math.sin(2 * PI * (q + f0) / 192))
        tronco.keyframe_insert('rotation_euler', frame=q + 1)
    for q in range(0, LACO + 1, 4):
        u = ((q + f0) % LACO) / LACO
        lado = math.exp(-((u - .55) / .07) ** 2)                  # olha para o lado uma vez por laço
        pesc.rotation_euler = (-.04 + .04 * math.sin(2 * PI * (q + f0) / 48) - .08 * lado, .0,
                               .22 + .05 * math.sin(2 * PI * (q + f0) / 96) + .65 * lado * (1 if agente == 'fiscal' else -1))
        pesc.keyframe_insert('rotation_euler', frame=q + 1)
    for q in range(0, LACO + 1, 2):
        pb = (q + f0) % 96
        olhos.scale = (1, 1, .12 if pb in (40, 42) else 1)
        olhos.keyframe_insert('scale', frame=q + 1)
        piv.rotation_euler = (-.07 + .05 * math.sin(2 * PI * (q + f0) / 48), .07 * math.sin(2 * PI * (q + f0) / 64), 0)
        piv.keyframe_insert('rotation_euler', frame=q + 1)
    for s, ombro, cot, pun in bracos:
        q0 = cot.rotation_quaternion.copy(); p0 = pun.rotation_quaternion.copy()
        for q in range(0, LACO + 1, 3):
            bate = max(0, math.sin(2 * PI * q / 6 + (0 if s > 0 else PI))) ** 2
            rajada = .55 + .45 * math.sin(2 * PI * (q + f0) / 64 + s)
            cot.rotation_quaternion = q0 @ Quaternion(V(1, 0, 0), -.07 * bate * rajada)
            cot.keyframe_insert('rotation_quaternion', frame=q + 1)
            pun.rotation_quaternion = p0 @ Quaternion(V(1, 0, 0), .2 * bate * rajada)
            pun.keyframe_insert('rotation_quaternion', frame=q + 1)
    for ob in (tronco, pesc, olhos, piv) + tuple(x for b in bracos for x in b[2:]):
        if ob.animation_data and ob.animation_data.action:
            ob.animation_data.action.name = 'laco-%s-%s' % (agente, ob.name)

# ───────────────────────── recepção, escada, estante, estar ─────────────────────────
def recepcao(loc, rot_z):
    col = COL['esc']
    g = vazio('recepcao', col, None, loc, (0, 0, rot_z))
    W, D, H = 2.5, 1.0, 1.02
    corpo = malha('balcao', bm_placa_arred(W, D, .46, H, 14), M['base'], col, g)
    b = corpo.modifiers.new('borda', 'BEVEL'); b.width = .03; b.segments = 3; b.harden_normals = True
    tampo = malha('balcao-tampo', bm_placa_arred(W + .08, D + .08, .5, .05, 14), material('osso', '#EFE6D8', rough=.5), col, g, (0, 0, H))
    b = tampo.modifiers.new('borda', 'BEVEL'); b.width = .015; b.segments = 2; b.harden_normals = True
    malha('balcao-rodape', bm_placa_arred(W - .02, D - .02, .45, .06, 14), M['rodape'], col, g)
    # "nó." do balcão: plano com o SVG oficial, sem extrusão, sombra nem contorno
    logo = plano_imagem('logo-balcao', 1.0, 1.0 * 964 / 1633, M['logo'], col, g, (0, -D / 2 - .004, .5), (PI / 2, 0, 0))
    logo.visible_shadow = False
    monitor('monitor-recepcao', col, g, (.35, .12, H + .05), .25, .56, .36, 1)
    planta('planta-balcao', 'suculenta', 1.1, 4, 'ceramica', col, g, (-.85, .15, H + .05))
    papeis(col, g, (-.3, -.12, H + .05), 2)
    vazio('marca-recepcao', col, g, (0, 0, .55))
    return g

def escada(loc, n=7, larg=1.15, passo=.34, alt=.17):
    col = COL['esc']
    g = vazio('escada', col, None, loc)
    for i in range(n):
        caixa('degrau', larg, passo + .02, alt * (i + 1), .03, M['base'], col, g, (0, i * passo, 0))
        caixa('degrau-borda', larg - .02, .03, .012, .006, material('creme', '#E2D4BE', rough=.5), col, g, (0, i * passo - passo / 2 + .005, alt * (i + 1) - .008))
    comp, topo = n * passo, n * alt
    caixa('patamar', larg + .1, 1.2, topo, .04, M['base'], col, g, (0, comp - passo / 2 + .6, 0))
    # mureta em rampa do lado de fora
    bm = bmesh.new()
    pts = [(-passo / 2, 0), (-passo / 2, .55), (comp - passo / 2, topo + .55), (comp - passo / 2 + 1.2, topo + .55), (comp - passo / 2 + 1.2, 0)]
    vs = [bm.verts.new((-larg / 2 - .07, y, z)) for y, z in pts]
    f = bm.faces.new(vs)
    ext = bmesh.ops.extrude_face_region(bm, geom=[f])
    bmesh.ops.translate(bm, vec=V(-.12, 0, 0), verts=[v for v in ext['geom'] if isinstance(v, bmesh.types.BMVert)])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    mur = malha('mureta', bm, M['parede'], col, g, liso=False)
    bv = mur.modifiers.new('borda', 'BEVEL'); bv.width = .02; bv.segments = 2; bv.harden_normals = True
    malha('corrimao', bm_tubo([V(larg / 2 - .05, -passo / 2, .95), V(larg / 2 - .05, comp - passo / 2, topo + .95)], .022, 10), M['madeira'], col, g)
    for i in range(0, n + 1, 2):
        z0 = alt * max(1, i); y = i * passo - (passo / 2 if i else 0)
        malha('balaustre', bm_cilindro(.012, .012, .95 + alt * i - z0, 8), M['grafite'], col, g, (larg / 2 - .05, y, z0))
    return g

def fileira_livros(nome, w, h, d, col, pai, loc):
    g = caixa(nome, w, d, h, .004, material('miolo-livros', '#E9DFCF', rough=.85), col, pai, loc)
    plano_imagem(nome + '-lombadas', w, h, M['livros'], col, g, (0, -d / 2 - .001, h / 2), (PI / 2, 0, 0))
    return g
def estante(loc, w=1.5, h=1.0, d=.4):
    col = COL['esc']
    g = vazio('estante', col, None, loc)
    caixa('estante-base', w, d, .05, .015, M['base'], col, g)
    for s in (-1, 1): caixa('estante-lado', .04, d, h, .012, M['base'], col, g, (s * (w / 2 - .02), 0, 0))
    caixa('estante-fundo', w, .02, h, .005, material('osso', '#EFE6D8'), col, g, (0, d / 2 - .01, 0))
    for z in (h * .5, h - .04): caixa('estante-prateleira', w, d, .035, .012, M['base'], col, g, (0, 0, z))
    fileira_livros('livros-a', w * .55, .3, d * .7, col, g, (-w * .2, 0, .05))
    fileira_livros('livros-b', w * .35, .26, d * .7, col, g, (w * .27, 0, h * .5 + .035))
    planta('planta-estante-a', 'folhagem', .55, 3, 'terracota', col, g, (w * .3, 0, .05))
    planta('planta-estante-b', 'suculenta', 1.2, 5, 'ceramica', col, g, (-w * .3, 0, h * .5 + .035))
    planta('planta-estante-c', 'folhagem', .45, 7, 'ceramica', col, g, (-w * .25, 0, h))
    pilha_livros(col, g, (w * .22, 0, h), ['#EDE3D2', '#2F3B52', '#D9B98A'])
    return g
def prateleira(loc, w=1.25):
    col = COL['esc']
    g = vazio('prateleira', col, None, loc)
    caixa('prateleira-tabua', w, .26, .045, .012, M['madeira'], col, g)
    for s in (-1, 1): caixa('mao-francesa', .025, .2, .12, .006, M['grafite'], col, g, (s * (w / 2 - .12), .02, -.12))
    fileira_livros('livros-parede', w * .45, .24, .18, col, g, (-w * .22, 0, .045))
    planta('planta-prateleira', 'folhagem', .5, 9, 'ceramica', col, g, (w * .3, 0, .045))
    return g
def janela(loc, w=1.7, h=1.25):
    col = COL['esc']
    g = vazio('janela', col, None, loc)
    plano_imagem('janela-vidro', w - .08, h - .08, M['janela'], col, g, (0, -.02, h / 2), (PI / 2, 0, 0))
    for z in (0, h - .06): caixa('janela-moldura', w, .08, .06, .015, M['base'], col, g, (0, -.02, z))
    for s in (-1, 0, 1): caixa('janela-montante', .06 if s else .035, .08, h, .012, M['base'], col, g, (s * (w / 2 - .03), -.02, 0))
    caixa('janela-peitoril', w + .14, .2, .04, .012, M['base'], col, g, (0, -.08, -.02))
    return g
def sofa(loc, rot_z=0, w=2.2):
    col = COL['esc']
    g = vazio('sofa', col, None, loc, (0, 0, rot_z))
    t, t2 = M['tecido'], material('tecido-claro', '#EDE3D3', rough=.95, sheen=.4)
    for a in (-1, 1):
        for b in (-1, 1): malha('sofa-pe', bm_cilindro(.025, .018, .1, 8), M['madeira_escura'], col, g, (a * (w / 2 - .1), b * .3, 0))
    caixa('sofa-base', w, .86, .26, .08, t, col, g, (0, 0, .09))
    caixa('sofa-encosto', w, .22, .44, .1, t, col, g, (0, .33, .3))
    for s in (-1, 1): caixa('sofa-braco', .2, .86, .32, .09, t, col, g, (s * (w / 2 - .1), 0, .3))
    lw = (w - .42) / 2
    for i in range(2):
        caixa('sofa-assento', lw - .02, .6, .13, .06, t2, col, g, (-w / 2 + .21 + lw * (i + .5), -.07, .34))
        caixa('sofa-almofada', lw - .06, .14, .36, .07, t2, col, g, (-w / 2 + .21 + lw * (i + .5), .2, .45), (-.15, 0, 0))
    caixa('sofa-almofada-solta', .34, .1, .3, .06, material('tecido-areia', '#D5BE9C', rough=.95, sheen=.4), col, g, (-w / 2 + .42, .1, .47), (.2, .15, .3))
    return g
def poltrona(loc, rot_z=0):
    col = COL['esc']
    g = vazio('poltrona', col, None, loc, (0, 0, rot_z))
    t = material('tecido-poltrona', '#E0D1BA', rough=.95, sheen=.4)
    for a in (-1, 1):
        for b in (-1, 1): malha('poltrona-pe', bm_cilindro(.022, .016, .12, 8), M['madeira_escura'], col, g, (a * .3, b * .28, 0))
    caixa('poltrona-base', .8, .78, .24, .1, t, col, g, (0, 0, .11))
    caixa('poltrona-encosto', .8, .2, .5, .1, t, col, g, (0, .3, .28), (.12, 0, 0))
    for s in (-1, 1): caixa('poltrona-braco', .16, .74, .28, .08, t, col, g, (s * .33, -.02, .3))
    caixa('poltrona-assento', .52, .56, .12, .06, material('tecido-claro', '#EDE3D3'), col, g, (0, -.06, .34))
    return g
def banco(loc, rot_z=0, w=1.35):
    col = COL['esc']
    g = vazio('banco', col, None, loc, (0, 0, rot_z))
    for a in (-1, 1):
        for b in (-1, 1): malha('banco-pe', bm_cilindro(.018, .018, .16, 8), M['grafite'], col, g, (a * (w / 2 - .08), b * .17, 0))
    caixa('banco-assento', w, .46, .2, .08, M['tecido_cinza'], col, g, (0, 0, .15))
    return g
def mesinha(loc, r=.3, h=.42):
    col = COL['esc']
    g = vazio('mesinha', col, None, loc)
    for i in range(3):
        a = i * 2 * PI / 3
        malha('mesinha-pe', bm_cilindro(.018, .014, h, 8), M['madeira'], col, g, (math.sin(a) * r * .55, math.cos(a) * r * .55, 0), (-math.cos(a) * .12, math.sin(a) * .12, 0))
    malha('mesinha-tampo', bm_cilindro(r, r, .04, 32), M['madeira'], col, g, (0, 0, h))
    return g
def tapete(nome, loc, w, d, mat, rot_z=0):
    return malha(nome, bm_placa_arred(w, d, .12, .018, 6), mat, COL['esc'], None, loc, (0, 0, rot_z))

# ───────────────────────── sala "nó tech stack" ─────────────────────────
def sala_tech_stack(loc, W, D, H):
    col = COL['sala']
    g = vazio('sala-tech-stack', col, None, loc)
    caixa('sala-piso', W, D, .08, .03, material('sala-base', '#EFE5D6', rough=.6), col, g)
    malha('sala-madeira', bm_caixa(W - .2, D - .2, .01, .004, 1), material('sala-assoalho', '#D7B488', rough=.5), col, g, (0, 0, .08))
    caixa('sala-parede-fundo', W, .12, H, .02, M['parede'], col, g, (0, D / 2 - .06, .08))
    caixa('sala-parede-direita', .12, D, H, .02, M['parede'], col, g, (W / 2 - .06, 0, .08))
    # vidro na frente (-Y) e à esquerda (-X), com caixilho preto
    def quadro(x0, y0, x1, y1, n):
        comp = math.hypot(x1 - x0, y1 - y0); ang = math.atan2(y1 - y0, x1 - x0)
        v = plano_imagem('vidro', comp, H - .05, M['vidro'], col, g, ((x0 + x1) / 2, (y0 + y1) / 2, .08 + H / 2), (PI / 2, 0, ang))
        v.visible_shadow = False
        for i in range(n + 1):
            t = i / n
            caixa('montante', .05, .05, H, .01, M['caixilho'], col, g, (x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, .08))
        for z in (.08, .08 + H - .05):
            caixa('travessa', comp, .05, .05, .01, M['caixilho'], col, g, ((x0 + x1) / 2, (y0 + y1) / 2, z), (0, 0, ang))
    quadro(-W / 2, -D / 2, W / 2, -D / 2, 4)
    quadro(-W / 2, -D / 2, -W / 2, D / 2, 3)
    caixa('friso-frente', W + .06, .1, .26, .02, M['caixilho'], col, g, (0, -D / 2, .08 + H))
    caixa('friso-esquerda', .1, D + .06, .26, .02, M['caixilho'], col, g, (-W / 2, 0, .08 + H))
    # racks com LEDs
    for i, x in enumerate((-W / 2 + .55, -W / 2 + 1.2)):
        r = caixa('rack', .58, .62, 1.75, .03, M['preto'], col, g, (x, D / 2 - .48, .08))
        plano_imagem('rack-frente', .5, 1.63, M['rack'], col, r, (0, -.312, .875), (PI / 2, 0, 0))
        for k in range(8):
            for j in range(3):
                cor = [MARCA['verde'], MARCA['azul'], MARCA['ambar']][(k + j + i) % 3]
                malha('led', bm_caixa(.022, .006, .014, .002, 1), material('led-' + cor, cor, emissao=cor, forca=8), col, r,
                      (.16 + j * .03 - .25 + .08, -.316, 1.75 - .12 - k * .2))
    # mesa de trabalho dentro, com monitor aceso e luminária
    t = malha('sala-mesa', bm_placa_arred(1.2, .65, .1, .05, 6), M['madeira'], col, g, (W / 2 - .85, -.1, .78))
    for a in (-1, 1):
        for b in (-1, 1): malha('sala-mesa-pe', bm_cilindro(.018, .018, .7, 8), M['base'], col, g, (W / 2 - .85 + a * .52, -.1 + b * .25, .08))
    monitor('sala-monitor', col, g, (W / 2 - .85, .05, .83), PI, .52, .34, 2)
    luminaria(col, g, (W / 2 - .4, .05, .83), PI * .9)
    cadeira('sala-cadeira', col, g, (W / 2 - .95, .55, .08), PI + .3, M['grafite'])
    planta('sala-planta-a', 'espada', 1.0, 4, 'ceramica', col, g, (W / 2 - .35, -D / 2 + .4, .08))
    planta('sala-planta-b', 'folhagem', .8, 8, 'terracota', col, g, (-W / 2 + .3, -D / 2 + .35, .08))
    # luz quente acesa lá dentro (Tela 3)
    lz = bpy.data.lights.new('sala-luz', 'POINT'); lz.energy = 120; lz.color = (1, .78, .55); lz.shadow_soft_size = .6
    objeto('sala-luz', lz, COL['luz'], g, (0, .2, 1.9))
    # placa com o lockup oficial no friso da frente
    pl = plano_imagem('placa-tech-stack', 1.9, 1.9 * 340 / 1400, M['placa'], col, g, (.1, -D / 2 - .06, .08 + H + .02), (PI / 2, 0, 0))
    pl.visible_shadow = False
    # hub azul onde as linhas chegam, rente ao vidro da esquerda
    hub = caixa('hub', .3, .24, .12, .05, M['azul'], col, g, (-W / 2 - .2, -D / 2 + .55, 0))
    vazio('marca-sala', col, g, (0, 0, 1.1))
    return g, hub

# ═══════════════════════ montagem ═══════════════════════
mesas = {
    'fiscal': mesa('fiscal', 0), 'auditor': mesa('auditor', 1), 'vaga': mesa('vaga', 2, ocupada=False)
}
for id_, (sx, sy) in {'fiscal': (.05, 1.95), 'auditor': (.6, .33), 'vaga': (1.15, -1.28)}.items():
    p = T1(sx, sy, ALT); mesas[id_].location = (p.x, p.y, 0)
yf = mesas['fiscal'].location.y
xf = mesas['fiscal'].location.x
Y_PAREDE = yf + 2.15

col = COL['esc']
luminaria(col, mesas['fiscal'], (.95, -.22, ALT), .4)
pilha_livros(col, mesas['fiscal'], (-.95, .18, ALT), ['#F4EFE6', '#E9E1D3', '#F6F2EA'], -.2)
planta('planta-mesa-fiscal', 'suculenta', 1.15, 1, 'ceramica', col, mesas['fiscal'], (.6, -.3, ALT))
papeis(col, mesas['fiscal'], (.35, .22, ALT), 3, -.3)
caixa_preta(col, mesas['auditor'], (-1.0, -.1, ALT), -.25)
caneca('caneca-auditor-2', col, mesas['auditor'], (.7, .15, ALT))
planta('planta-mesa-auditor', 'suculenta', 1.05, 2, 'salvia', col, mesas['auditor'], (.55, -.32, ALT))
papeis(col, mesas['auditor'], (.25, .25, ALT), 2, .2)
planta('planta-mesa-vaga', 'suculenta', 1.15, 3, 'ceramica', col, mesas['vaga'], (.75, -.28, ALT))
papeis(col, mesas['vaga'], (-.15, .28, ALT), 2, -.25)
caneca('caneca-vaga', col, mesas['vaga'], (.35, -.05, ALT))

PESSOAS = {
    'fiscal': pessoa('fiscal', '#F0C7A4', '#2E2019', 'liso', '#3D4350', '#3A2E26', MARCA['verde'], 0, mesas['fiscal']),
    'auditor': pessoa('auditor', '#7A4B33', '#16110E', 'crespo', '#2F3A4C', '#1E1B19', MARCA['azul'], 3.3, mesas['auditor']),
}
for id_ in ('fiscal', 'auditor'):
    A = ASSENTO
    mouse(col, mesas[id_], (A.x - .33, .3, ALT))
    caneca('caneca-' + id_, col, mesas[id_], (A.x + .44, .31, ALT), material('caneca-' + id_, '#FFFFFF' if id_ == 'fiscal' else '#EDE6DA', rough=.3))

# chão, parede do fundo, rodapé, janela, estante e prateleira
piso = caixa('piso', 34, 30, .3, .05, M['piso'], col, None, (2, Y_PAREDE - 15 + .2, -.3))
parede = caixa('parede-fundo', 24, .26, 2.7, .04, M['parede'], col, None, (3, Y_PAREDE + .13, 0))
caixa('rodape', 24, .04, .1, .01, M['rodape'], col, None, (3, Y_PAREDE - .02, 0))
janela((xf + 2.55, Y_PAREDE, .95))
estante((xf - .55, Y_PAREDE - .22, 0))
prateleira((xf - .55, Y_PAREDE - .13, 1.62))
planta('planta-parede', 'espada', 1.25, 12, 'terracota', col, None, (xf + 1.25, Y_PAREDE - .35, 0))
escada((xf - 2.75, Y_PAREDE - 1.2 - 7 * .34 - .05 + .17, 0))
planta('planta-patamar', 'folhagem', 1.1, 14, 'ceramica', col, None, (xf - 2.7, Y_PAREDE - .55, 7 * .17))

p = T1(-1.4, -2.35, .5); recepcao((p.x, p.y, 0), AZ * .6)
p = T1(1.7, -2.8); banco((p.x, p.y, 0), AZ * .3)
p = T1(2.0, -3.05); tapete('tapete-banco', (p.x, p.y, 0), 1.9, 1.3, M['tapete'], AZ * .3)
p = T1(2.35, -3.35); g = mesinha((p.x, p.y, 0), .22, .38); planta('planta-banquinho', 'suculenta', 1.1, 6, 'ceramica', col, g, (0, 0, .42))
for i, (tipo, e, (sx, sy), vaso) in enumerate([
        ('folhagem', 1.5, (-2.6, -.95), 'ceramica'), ('espada', 1.2, (-.4, -.85), 'ceramica'), ('folhagem', 1.35, (-.05, -2.25), 'ceramica'),
        ('folhagem', 1.45, (6.75, -.8), 'ceramica'), ('espada', 1.3, (6.9, -2.3), 'terracota'), ('arbusto', 1.2, (-2.55, 2.3), 'salvia'),
        ('folhagem', 1.3, (2.25, 2.45), 'ceramica'), ('folhagem', 1.3, (-2.65, -3.6), 'ceramica'), ('espada', 1.25, (.9, -4.1), 'ceramica'),
        ('arbusto', 1.25, (3.75, -2.0), 'terracota'), ('folhagem', 1.3, (7.3, -1.3), 'ceramica'), ('espada', 1.3, (7.1, -3.6), 'salvia'),
        ('folhagem', 1.25, (3.4, -4.4), 'ceramica'), ('folhagem', 1.2, (-1.5, -4.9), 'ceramica')]):
    q = T1(sx, sy); planta('planta-%02d' % i, tipo, e, 20 + i, vaso, col, None, (q.x, q.y, 0))

# sala menor e perto da coluna (R7): o canto de trás fica logo fora da borda direita da Tela 1
SW, SD, SH = 2.6, 2.2, 2.3
y_sala = Y_PAREDE - .3 - SD / 2
x_sala = (2.15 - DIREITA.y * (y_sala + SD / 2)) / DIREITA.x + SW / 2
sala, hub = sala_tech_stack((x_sala, y_sala, 0), SW, SD, SH)
# estar logo abaixo da sala na tela, como na Tela 3
bpy.context.view_layer.update()
_c = [sala.matrix_world @ V(x * SW / 2, y * SD / 2, 0) for x in (-1, 1) for y in (-1, 1)]
_sx = sum(tela_de(c)[0] for c in _c) / 4; _sy = min(tela_de(c)[1] for c in _c)
p = na_tela(_sx + .35, _sy - 1.45); tapete('tapete-estar', (p.x, p.y, 0), 3.0, 2.2, M['tapete'])
p = na_tela(_sx + .55, _sy - 1.0, .2); sofa((p.x, p.y, 0), 0)
p = na_tela(_sx - .8, _sy - 1.6); poltrona((p.x, p.y, 0), -.9)
p = na_tela(_sx + .65, _sy - 2.0); g = mesinha((p.x, p.y, 0), .3, .4); planta('planta-mesinha', 'suculenta', 1.2, 30, 'ceramica', col, g, (0, 0, .44))

# ───────────── as três linhas azuis: das mesas, pelo chão, até o hub da sala (R7) ─────────────
bpy.context.view_layer.update()
hubP = hub.matrix_world.translation.copy()
Y0 = .03
ondas = {'fiscal': (-.18, .05), 'auditor': (-.3, .0), 'vaga': (.2, .0)}
hx, hy = tela_de(V(hubP.x, hubP.y, 0))
for id_, (A_, B_) in ondas.items():
    mw = mesas[id_].matrix_world
    s0 = mw @ V(LARG / 2 - .3, -.22, ALT + .012); s1 = mw @ V(LARG / 2 + .02, -.22, ALT - .03); d0 = mw @ V(LARG / 2 + .3, -.32, Y0)
    dx_, dy_ = tela_de(V(d0.x, d0.y, 0))
    ex, ey = hx - dx_, hy - dy_; nn = math.hypot(ex, ey); px_, py_ = -ey / nn, ex / nn
    pts = [s0, s1, d0]
    for t in (.22, .45, .68, .86):
        o = A_ * math.sin(PI * t) + B_ * math.sin(2 * PI * t)
        pts.append(na_tela(dx_ + ex * t + px_ * o, dy_ + ey * t + py_ * o, Y0))
    pts.append(V(hubP.x, hubP.y, .06))
    cu = bpy.data.curves.new('linha-' + id_, 'CURVE'); cu.dimensions = '3D'
    cu.bevel_depth = .024; cu.bevel_resolution = 4; cu.resolution_u = 16
    sp = cu.splines.new('BEZIER'); sp.bezier_points.add(len(pts) - 1)
    for bp, pt in zip(sp.bezier_points, pts):
        bp.co = pt; bp.handle_left_type = bp.handle_right_type = 'AUTO'
    cu.materials.append(M['azul'])
    ob = objeto('linha-' + id_, cu, COL['lin'])
    # a linha acende das mesas até a sala ao longo do laço (a página vai ligar isso à rolagem)
    # na página a linha acende conforme a rolagem (bevel_factor_end de 0 a 1); aqui fica inteira

# ───────────────────────── luz e mundo (R3) ─────────────────────────
mundo = bpy.data.worlds.new('mundo'); cena.world = mundo
mundo.use_nodes = True
nt = mundo.node_tree; bg = nt.nodes['Background']
bg.inputs['Color'].default_value = lin('#F2E8DA'); bg.inputs['Strength'].default_value = .6
# a câmera vê o fundo da página (osso); a luz do céu continua quente
cam_bg = nt.nodes.new('ShaderNodeBackground'); cam_bg.inputs['Color'].default_value = lin(MARCA['osso']); cam_bg.inputs['Strength'].default_value = 1
lp = nt.nodes.new('ShaderNodeLightPath'); mx = nt.nodes.new('ShaderNodeMixShader')
nt.links.new(lp.outputs['Is Camera Ray'], mx.inputs['Fac'])
nt.links.new(bg.outputs[0], mx.inputs[1]); nt.links.new(cam_bg.outputs[0], mx.inputs[2])
nt.links.new(mx.outputs[0], nt.nodes['World Output'].inputs['Surface'])

sol = bpy.data.lights.new('sol', 'SUN'); sol.energy = 3.4; sol.color = (1.0, .94, .86); sol.angle = math.radians(7)
centro = na_tela(2.0, -.5)
dir_sol = V(-9, -2.2, 9.5).normalized()
o_sol = objeto('sol', sol, COL['luz'], loc=tuple(centro + dir_sol * 15))
o_sol.rotation_euler = (-dir_sol).to_track_quat('-Z', 'Y').to_euler()
pre = bpy.data.lights.new('preenchimento', 'SUN'); pre.energy = .5; pre.color = (.95, .96, 1.0); pre.angle = math.radians(30)
pre.use_shadow = False
d2 = V(6, -12, 7).normalized()
o_pre = objeto('preenchimento', pre, COL['luz'], loc=tuple(centro + d2 * 15)); o_pre.rotation_euler = (-d2).to_track_quat('-Z', 'Y').to_euler()

ee = cena.eevee
for k, v in [('taa_render_samples', 96), ('use_raytracing', True), ('use_shadows', True), ('shadow_ray_count', 2), ('shadow_step_count', 8),
             ('use_fast_gi', True), ('fast_gi_distance', 1.5), ('horizon_quality', 1.0), ('use_gtao', True), ('gtao_distance', .8)]:
    try: setattr(ee, k, v)
    except Exception: pass
try:
    ee.ray_tracing_options.resolution_scale = '1'
    ee.fast_gi_method = 'GLOBAL_ILLUMINATION'
except Exception: pass
try: cena.view_settings.view_transform = 'Khronos PBR Neutral'
except Exception: cena.view_settings.view_transform = 'Standard'
cena.view_settings.look = 'None'; cena.view_settings.exposure = 0; cena.view_settings.gamma = 1
cena.render.film_transparent = False

# ───────────────────────── câmeras ─────────────────────────
ALTURA_T1 = 6.72                               # mundo visível na Tela 1 (375:520, largura 4,85)
def camera(nome, alvo, altura, res):
    cd = bpy.data.cameras.new(nome); cd.type = 'ORTHO'; cd.ortho_scale = altura; cd.sensor_fit = 'VERTICAL'
    cd.clip_start = .1; cd.clip_end = 200
    ob = objeto(nome, cd, COL['cam'], loc=tuple(alvo + DIR_CAM * 40))
    ob.rotation_euler = (-DIR_CAM).to_track_quat('-Z', 'Y').to_euler()
    ob['resolucao'] = list(res)
    return ob
CAMS = {}
CAMS['Tela1'] = camera('Tela1', na_tela(0, .02), ALTURA_T1, (750, 1040))
def alvo_mesa(id_, desloc):
    return mesas[id_].matrix_world @ V(.15, 0, ALT) + DIREITA * desloc[0] + CIMA * desloc[1]
CAMS['Tela2_fiscal'] = camera('Tela2_fiscal', alvo_mesa('fiscal', (-.05, .42)), 2.05, (750, 620))
CAMS['Tela2_auditor'] = camera('Tela2_auditor', alvo_mesa('auditor', (-.05, .42)), 2.05, (750, 620))
# fecho: a câmera viaja até a sala e a enquadra em destaque, com a mesma altura de quadro (±15%)
ALTURA_F = ALTURA_T1 * 1.14                     # R7: no máximo 15% acima da Tela 1
cantos = [sala.matrix_world @ V(x * SW / 2, y * SD / 2, z) for x in (-1, 1) for y in (-1, 1) for z in (0, SH + .4)]
xs = [tela_de(c)[0] for c in cantos]; ys = [tela_de(c)[1] for c in cantos]
larg_f = ALTURA_F * 750 / 1040
cx = max(xs) + .15 - larg_f * .5                     # a sala encosta na direita; as mesas entram pela esquerda
cy = (min(ys) + max(ys)) / 2 - ALTURA_F * .14     # a sala um pouco acima do meio
CAMS['Fecho_sala'] = camera('Fecho_sala', na_tela(cx, cy, 0), ALTURA_F, (750, 1040))
print('SALA_LARGURA_NO_FECHO', round((max(xs) - min(xs)) / larg_f * 100, 1))
cena.camera = CAMS['Tela1']

# ───────────────── etiquetas (só prévia): chips voltados para a câmera da Tela 1 ─────────────────
rot_cam = CAMS['Tela1'].rotation_euler.copy()
def etiqueta(nome, png, w_px, h_px, mesa_id, local, altura_mundo):
    mt = material('chip-' + nome, '#FFFFFF', imagem=png, sem_luz=True)
    w = altura_mundo * w_px / h_px
    pl = plano_imagem('etiqueta-' + nome, w, altura_mundo, mt, COL['eti'], None, tuple(mesas[mesa_id].matrix_world @ V(*local)), tuple(rot_cam))
    pl.visible_shadow = False
    return pl
# círculo de 60 px numa textura de 140 px (170 na de duas linhas): ≥ 16 px em 375 de largura (R4)
etiqueta('fiscal', 'chip-fiscal.png', 440, 140, 'fiscal', (.62, .35, 1.72), .55)
etiqueta('auditor', 'chip-auditor.png', 440, 140, 'auditor', (.78, .3, 1.66), .55)
etiqueta('vaga', 'chip-vaga.png', 430, 170, 'vaga', (.55, .35, 1.3), .67)
for nome, h_px, h_mundo in [('fiscal', 140, .55), ('vaga', 170, .67)]:
    print('CIRCULO_PX_375', nome, round(60 / h_px * h_mundo * 375 / (ALTURA_T1 * 750 / 1040), 1))

# ───────────────────────── salvar e renderizar ─────────────────────────
for ob in bpy.data.objects:
    if ob.type == 'MESH':
        ob.data.update()
BLEND = os.path.join(AQUI, 'escritorio.blend')
bpy.ops.wm.save_as_mainfile(filepath=BLEND, compress=True)
bpy.ops.file.make_paths_relative()          # texturas por caminho relativo: o .blend abre em qualquer pasta
bpy.ops.wm.save_as_mainfile(filepath=BLEND, compress=True)
if os.path.exists(BLEND + '1'): os.remove(BLEND + '1')
print('SALVO', BLEND)

def projeta(cam, ob):
    from bpy_extras.object_utils import world_to_camera_view
    co = world_to_camera_view(cena, cam, ob.matrix_world.translation)
    return round(co.x * 100, 1), round((1 - co.y) * 100, 1)
info = {}
for nome, cam in CAMS.items():
    cena.camera = cam
    cena.render.resolution_x, cena.render.resolution_y = cam['resolucao']
    info[nome] = {k: projeta(cam, bpy.data.objects[k]) for k in ['marca-mesa-fiscal', 'marca-mesa-auditor', 'marca-mesa-vaga', 'marca-recepcao', 'marca-sala', 'marca-pessoa-fiscal', 'marca-pessoa-auditor']}
    info[nome].update({k: projeta(cam, bpy.data.objects[k]) for k in ['etiqueta-fiscal', 'etiqueta-auditor', 'etiqueta-vaga']})
with open(os.path.join(AQUI, 'projecoes.json'), 'w', encoding='utf8') as f:
    json.dump(info, f, indent=1, ensure_ascii=False)
print('PROJECOES', json.dumps(info))

if '--sem-render' not in ARGS:
    so = [a for a in ARGS if a in CAMS] or list(CAMS)
    cena.frame_set(int(ARGS[ARGS.index('--quadro') + 1]) if '--quadro' in ARGS else 1)
    for nome in so:
        cam = CAMS[nome]
        cena.camera = cam
        cena.render.resolution_x, cena.render.resolution_y = cam['resolucao']
        cena.render.resolution_percentage = 100
        cena.render.image_settings.file_format = 'PNG'
        for ob in COL['eti'].objects: ob.hide_render = nome != 'Tela1'   # a Tela 3 não tem etiquetas
        for ob in list(COL['lin'].objects) + [hub]: ob.hide_render = nome != 'Fecho_sala'   # linhas e hub só acendem na viagem até a sala
        cena.render.filepath = os.path.join(AQUI, 'previa-%s.png' % nome)
        bpy.ops.render.render(write_still=True)
        print('RENDER', nome)
    cena.camera = CAMS['Tela1']
    cena.render.resolution_x, cena.render.resolution_y = CAMS['Tela1']['resolucao']
    bpy.ops.wm.save_as_mainfile(filepath=BLEND, compress=True)
    if os.path.exists(BLEND + '1'): os.remove(BLEND + '1')
