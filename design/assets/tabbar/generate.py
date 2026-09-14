from pathlib import Path
from PIL import Image, ImageDraw
root = Path(__file__).resolve().parents[3]
scale = 12
for name in ('home', 'family'):
    for active in (False, True):
        im = Image.new('RGBA', (24*scale,24*scale))
        d = ImageDraw.Draw(im)
        ink = '#5860b5' if active else '#858391'
        def box(coords): return tuple(round(v*scale) for v in coords)
        def line(points, fill=ink, width=1.65):
            pts=[(round(x*scale),round(y*scale)) for x,y in points]
            d.line(pts,fill=fill,width=round(width*scale),joint='curve')
            r=width*scale/2
            for x,y in (pts[0],pts[-1]): d.ellipse((x-r,y-r,x+r,y+r),fill=fill)
        if active: d.rounded_rectangle(box((0,0,24,24)),radius=7*scale,fill='#ececf8')
        if name=='home':
            d.rounded_rectangle(box((5.5,4,18.5,20)),radius=2.5*scale,outline=ink,width=round(1.65*scale))
            d.rounded_rectangle(box((9,2.7,15,6)),radius=1.2*scale,fill=ink)
            line([(8.5,10.6),(9.6,11.7),(11.6,9.4)],width=1.5)
            line([(13.5,10.7),(15.5,10.7)],width=1.5)
            line([(8.5,15.5),(9.6,16.6),(11.6,14.3)],width=1.5)
            line([(13.5,15.6),(15.5,15.6)],width=1.5)
        else:
            line([(3.5,10.5),(12,3.5),(20.5,10.5)])
            line([(5.5,9.5),(5.5,19.5),(18.5,19.5),(18.5,9.5)])
            # 两位家人，用圆头与相连肩线表达家庭。
            for x in (9.4,14.6): d.ellipse(box((x-1.4,10.2,x+1.4,13)),fill=ink)
            d.rounded_rectangle(box((7.5,14,11.3,17.5)),radius=1.6*scale,fill=ink)
            d.rounded_rectangle(box((12.7,14,16.5,17.5)),radius=1.6*scale,fill=ink)
        filename=f'tab-{name}{"-active" if active else ""}.png'
        im.resize((81,81),Image.Resampling.LANCZOS).save(root/'miniprogram/assets'/filename)
