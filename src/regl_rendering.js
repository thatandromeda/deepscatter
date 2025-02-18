/* eslint-disable no-underscore-dangle */
import wrapREGL from 'regl';
import { create } from 'd3-selection';
import { range, sum } from 'd3-array';
// import { contours } from 'd3-contour';
import unpackFloat from 'glsl-read-float';
import { window_transform } from './interaction';
import { Renderer } from './rendering';
import gaussian_blur from './glsl/gaussian_blur.frag';
import vertex_shader from './glsl/general.vert';
import frag_shader from './glsl/general.frag';
import { aesthetic_variables, AestheticSet } from './AestheticSet';

// eslint-disable-next-line import/prefer-default-export
export class ReglRenderer extends Renderer {
  constructor(selector, tileSet, scatterplot) {
    super(selector, tileSet, scatterplot);
    this.regl = wrapREGL(
      {
        //      extensions: 'angle_instanced_arrays',
        optionalExtensions: [
          'OES_standard_derivatives',
          'OES_element_index_uint',
          'OES_texture_float',
          'OES_texture_half_float',
        ],
        canvas: this.canvas.node(),
      },
    );

    this.aes = new AestheticSet(scatterplot, this.regl, tileSet);
    // allocate buffers in 64 MB blocks.
    this.buffer_size = 1024 * 1024 * 64;

    this.initialize_textures();
    // Not the right way, for sure.
    this._initializations = [
    // some things that need to be initialized before the renderer is loaded.
      this.tileSet
        .promise
        .then(() => {
          this.remake_renderer();
          this._webgl_scale_history = [this.default_webgl_scale, this.default_webgl_scale];
        }),
    ];
    this.initialize();
  }

  get buffers() {
    this._buffers = this._buffers
    || new MultipurposeBufferSet(this.regl, this.buffer_size);
    return this._buffers;
  }

  data(dataset) {
    if (dataset === undefined) {
      return this.tileSet;
    }
    this.tileSet = dataset;
    return this;
  }

  apply_webgl_scale() {
  // Should probably be attached to AestheticSet, not to this class.

    // The webgl transform can either be 'literal', in which case it uses
    // the settings linked to the zoom pyramid, or semantic (linear, log, etc.)
    // in which case it has to calculate off of the x and y dimensions.

    this._use_scale_to_download_tiles = true;
    if (
      (this.aes.encoding.x.transform && this.aes.encoding.x.transform !== 'literal')
    || (this.aes.encoding.y.transform && this.aes.encoding.y.transform !== 'literal')
    ) {
      const webglscale = window_transform(this.aes.x.scale, this.aes.y.scale).flat();
      this._webgl_scale_history.unshift(webglscale);
      this._use_scale_to_download_tiles = false;
    } else {
      if (!this._webgl_scale_history) {
        this._webgl_scale_history = [];
      }
      // Use the default linked to the coordinates used to build the tree.
      this._webgl_scale_history.unshift(this.default_webgl_scale);
    }
  }

  get props() {
    const { prefs } = this;
    const { transform } = this.zoom;
    const { aes_to_buffer_num, buffer_num_to_variable, variable_to_buffer_num } = this.allocate_aesthetic_buffers();
    const props = {
    // Copy the aesthetic as a string.
      aes: { encoding: this.aes.encoding },
      colors_as_grid: 0,
      corners: this.zoom.current_corners(),
      zoom_balance: prefs.zoom_balance,
      transform,
      max_ix: this.max_ix,
      time: (Date.now() - this.zoom._start) / 1000,
      update_time: (Date.now() - this.most_recent_restart) / 1000,
      string_index: 0,
      prefs: JSON.parse(JSON.stringify(prefs)),
      color_type: undefined,
      start_time: this.most_recent_restart,
      webgl_scale: this._webgl_scale_history[0],
      last_webgl_scale: this._webgl_scale_history[1],
      use_scale_for_tiles: this._use_scale_to_download_tiles,
      grid_mode: 0,
      buffer_num_to_variable,
      aes_to_buffer_num,
      variable_to_buffer_num,
      color_picker_mode: 0, // whether to draw as a color picker.
    };

    props.zoom_matrix = [
      [props.transform.k, 0, props.transform.x],
      [0, props.transform.k, props.transform.y],
      [0, 0, 1],
    ].flat();

    // Clone.
    return JSON.parse(JSON.stringify(props));
  }

  get default_webgl_scale() {
    if (this._default_webgl_scale) {
      return this._default_webgl_scale;
    }
    this._default_webgl_scale = this.zoom.webgl_scale();
    return this._default_webgl_scale;
  }

  render_points(props) {
  // Regl is faster if it can render a large number of draw calls together.
    const prop_list = [];
    for (const tile of this.visible_tiles()) {
    // Do the binding operation; returns truthy if it's already done.
      const manager = new TileBufferManager(this.regl, tile, this);
      try {
        if (!manager.ready(props.prefs, props.block_for_buffers)) {
        // The 'ready' call also pushes a creation request into
        // the deferred_functions queue.
          continue;
        }
      } catch (err) {
        //       console.warn(err);
      // throw "Dead"
        continue;
      }

      const this_props = {
        manager,
        image_locations: manager.image_locations,
        sprites: this.sprites,
      };
      Object.assign(this_props, props);
      prop_list.push(this_props);
    }

    if (this._renderer === undefined) {
      if (this._zoom && this._zoom._timer) {
        this._zoom._timer.stop();
      }
      return;
    }
    // Do the lowest tiles first.
    prop_list.reverse();
    this._renderer(prop_list);
  }

  tick() {
    const { prefs } = this;
    const { regl, tileSet } = this;
    const { props } = this;

    this.tick_num = this.tick_num || 0;
    this.tick_num++;

    // Set a download call in motion.
    if (this._use_scale_to_download_tiles) {
      tileSet.download_most_needed_tiles(this.zoom.current_corners(), this.props.max_ix);
    } else {
      tileSet.download_to_depth(prefs.max_points);
    }

    regl.clear({
      color: [0.9, 0.9, 0.93, 0],
      depth: 1,
    });

    const start = Date.now();
    let current = () => undefined;
    while (Date.now() - start < 10 && this.deferred_functions.length) {
    // Keep popping deferred functions off the queue until we've spent 10 milliseconds doing it.
      current = this.deferred_functions.shift();
      try {
        current();
      } catch (err) {
        console.warn(err, current);
      }
    }

    this.render_all(props);
  }

  render_jpeg(props) {

  }

  single_blur_pass(fbo1, fbo2, direction) {
    const { regl } = this;
    fbo2.use(() => {
      regl.clear({ color: [0, 0, 0, 0] });
      regl(
        {
          frag: gaussian_blur,
          uniforms: {
            iResolution: ({ viewportWidth, viewportHeight }) => [viewportWidth, viewportHeight],
            iChannel0: fbo1,
            direction,
          },
          /* blend: {
        enable: true,
        func: {
          srcRGB: 'one',
          srcAlpha: 'one',
          dstRGB: 'one minus src alpha',
          dstAlpha: 'one minus src alpha',
        },
      }, */
          vert: `
        precision mediump float;
        attribute vec2 position;
        varying vec2 uv;
        void main() {
          uv = 0.5 * (position + 1.0);
          gl_Position = vec4(position, 0, 1);
        }`,
          attributes: {
            position: [-4, -4, 4, -4, 0, 4],
          },
          depth: { enable: false },
          count: 3,
        },
      )();
    });
  }

  blur(fbo1, fbo2, passes = 3) {
    let remaining = passes - 1;
    while (remaining > -1) {
      this.single_blur_pass(fbo1, fbo2, [2 ** remaining, 0]);
      this.single_blur_pass(fbo2, fbo1, [0, 2 ** remaining]);
      remaining -= 1;
    }
  }

  render_all(props) {
    const { regl } = this;


    this.fbos.points.use(() => {
      regl.clear({ color: [0, 0, 0, 0] });
      this.render_points(props);
    });
    /*
    if (this.geolines) {
      this.fbos.lines.use(() => {
        regl.clear({ color: [0, 0, 0, 0] });
        this.geolines.render(props);
      });
    }

    if (this.geo_polygons && this.geo_polygons.length) {
      this.fbos.lines.use(() => {
        regl.clear({ color: [0, 0, 0, 0] });
        for (const handler of this.geo_polygons) {
          handler.render(props);
        }
      });
    }
    */
    regl.clear({ color: [0, 0, 0, 0] });
    this.fbos.lines.use(() => regl.clear({ color: [0, 0, 0, 0] }));
    if (this.scatterplot.trimap) {
      // Allows binding a TriMap from `trifeather` object to the regl package without any import.
      // This is the best way to do it that I can think of for now.
      this.fbos.lines.use(() => {
        this.scatterplot.trimap.zoom = this.zoom;
        this.scatterplot.trimap.tick('polygon');
      });
    }
    // Copy the points buffer to the main buffer.

    for (const layer of [this.fbos.lines, this.fbos.points]) {
      regl({
        profile: true,
        blend: {
          enable: true,
          func: {
            srcRGB: 'one',
            srcAlpha: 'one',
            dstRGB: 'one minus src alpha',
            dstAlpha: 'one minus src alpha',
          },
        },

        frag: `
        precision mediump float;
        varying vec2 uv;
        uniform sampler2D tex;
        uniform float wRcp, hRcp;
        void main() {
          gl_FragColor = texture2D(tex, uv);
        }
      `,
        vert: `
        precision mediump float;
        attribute vec2 position;
        varying vec2 uv;
        void main() {
          uv = 0.5 * (position + 1.0);
          gl_Position = vec4(position, 0, 1);
        }
      `,
        attributes: {
          position: this.fill_buffer,
        },
        depth: { enable: false },
        count: 3,
        uniforms: {
          tex: () => layer,
          wRcp: ({ viewportWidth }) => 1.0 / viewportWidth,
          hRcp: ({ viewportHeight }) => 1.0 / viewportHeight,
        },
      })();
    }
  }

  set_image_data(tile, ix) {
  // Stores a *single* image onto the texture.
    const { regl } = this;

    this.initialize_sprites(tile);

    //    const { sprites, image_locations } = tile._regl_elements;
    const { current_position } = sprites;
    if (current_position[1] > (4096 - 18 * 2)) {
      console.error(`First spritesheet overflow on ${tile.key}`);
      // Just move back to the beginning. Will cause all sorts of havoc.
      sprites.current_position = [0, 0];
      return;
    }
    if (!tile.table.get(ix)._jpeg) {

    }
  }

  spritesheet_setter(word) {
  // Set if not there.
    let ctx = 0;
    if (!this.spritesheet) {
      const offscreen = create('canvas')
        .attr('width', 4096)
        .attr('width', 4096)
        .style('display', 'none');

      ctx = offscreen.node().getContext('2d');
      const font_size = 32;
      ctx.font = `${font_size}px Times New Roman`;
      ctx.fillStyle = 'black';
      ctx.lookups = new Map();
      ctx.position = [0, font_size - font_size / 4.0];
      this.spritesheet = ctx;
    } else {
      ctx = this.spritesheet;
    }
    let [x, y] = ctx.position;

    if (ctx.lookups.get(word)) {
      return ctx.lookups.get(word);
    }
    const w_ = ctx.measureText(word).width;
    if (w_ > 4096) {
      return;
    }
    if ((x + w_) > 4096) {
      x = 0;
      y += font_size;
    }
    ctx.fillText(word, x, y);
    lookups.set(word, { x, y, width: w_ });
    // ctx.strokeRect(x, y - font_size, width, font_size)
    x += w_;
    ctx.position = [x, y];
    return lookups.get(word);
  }

  initialize_textures() {
    const { regl } = this;
    this.fbos = this.fbos || {};
    this.fbos.empty_texture = regl.texture(
      range(128).map((d) => range(128).map((d) => [0, 0, 0])),
    );

    this.fbos.minicounter = regl.framebuffer({
      width: 512,
      height: 512,
      depth: false,
    });

    this.fbos.lines = regl.framebuffer({
      // type: 'half float',
      width: this.width,
      height: this.height,
      depth: false,
    });

    this.fbos.points = regl.framebuffer({
      // type: 'half float',
      width: this.width,
      height: this.height,
      depth: false,
    });

    this.fbos.ping = regl.framebuffer({
      width: this.width,
      height: this.height,
      depth: false,
    });

    this.fbos.pong = regl.framebuffer({
      width: this.width,
      height: this.height,
      depth: false,
    });

    this.fbos.contour = this.fbos.contour
    || regl.framebuffer({
      width: this.width,
      height: this.height,
      depth: false,
    });

    this.fbos.colorpicker = this.fbos.colorpicker
    || regl.framebuffer({
      width: this.width,
      height: this.height,
      depth: false,
    });

    this.fbos.dummy = this.fbos.dummy || regl.framebuffer({
      width: 1,
      height: 1,
      depth: false,
    });

    this.fbos.dummy_buffer = regl.buffer(10);
  }

  get_image_texture(url) {
    const { regl } = this;
    this.textures = this.textures || {};
    if (this.textures[url]) {
      return this.textures[url];
    }
    const image = new Image();
    image.src = url;
    this.textures[url] = this.fbos.minicounter;
    image.onload = () => {
      console.log('loaded image', url);
      this.textures[url] = regl.texture(image);
    };
    return this.textures[url];
  }

  plot_as_grid(x_field, y_field, buffer = this.fbos.minicounter) {
    console.log('plotting as grid');
    const { scatterplot, regl, tileSet } = this.aes;

    const saved_aes = this.aes;

    if (buffer === undefined) {
    // Mock up dummy syntax to use the main draw buffer.
      buffer = {
        width: this.width,
        height: this.height,
        use: (f) => f(),
      };
    }

    const { width, height } = buffer;

    this.aes = new AestheticSet(scatterplot, regl, tileSet);

    const x_length = map._root.table.getColumn(x_field).data.dictionary.length;

    const stride = 1;

    let nearest_pow_2 = 1;
    while (nearest_pow_2 < x_length) {
      nearest_pow_2 *= 2;
    }

    const encoding = {
      x: {
        field: x_field,
        transform: 'linear',
        domain: [-2047, -2047 + nearest_pow_2],
      },
      y: y_field !== undefined ? {
        field: y_field,
        transform: 'linear',
        domain: [-2047, -2020],

      } : { constant: -1 },
      size: 1,
      color: {
        constant: [0, 0, 0],
        transform: 'literal',
      },
      jitter_radius: {
        constant: 1 / 2560, // maps to x jitter
        method: 'uniform', // Means x in radius and y in speed.
      },

      jitter_speed: y_field === undefined ? 1 : 1 / 256, // maps to y jitter
    };
    console.log(`map.plotAPI({encoding: ${JSON.stringify(encoding)}})`);
    // Twice to overwrite the defaults and avoid interpolation.
    this.aes.apply_encoding(encoding);
    this.aes.apply_encoding(encoding);
    this.aes.x[1] = saved_aes.x[0];
    this.aes.y[1] = saved_aes.y[0];
    this.aes.filter1 = saved_aes.filter1;
    this.aes.filter2 = saved_aes.filter2;

    const { props } = this;
    props.block_for_buffers = true;
    props.grid_mode = 1;

    const minilist = new Uint8Array(width * height * 4);

    buffer.use(() => {
      this.regl.clear({ color: [0, 0, 0, 0] });
      this.render_points(props);
      regl.read({ data: minilist });
    });
    // Then revert back.
    this.aes = saved_aes;
  }

  count_colors(field) {
    const { regl, props } = this;
    props.prefs.jitter = null;
    if (field !== undefined) {
      console.warn('PROBABLY BROKEN BECAUSE OF THE NEW AES', field, props.prefs, field);
      props.aes.encoding.color = {
        field,
        domain: [-2047, 2047],
      // range: "shufbow"
      };
    } else {
      field = this.aes.color.field;
    }

    props.only_color = -1;
    props.colors_as_grid = 1.0;
    props.block_for_buffers = true;

    const { width, height } = this.fbos.minicounter;
    const minilist = new Uint8Array(width * height * 4);
    const counts = new Map();
    this.fbos.minicounter.use(() => {
      regl.clear({ color: [0, 0, 0, 0] });
      this.render_points(props);
      regl.read(
        { data: minilist },
      );
    });
    for (const [k, v] of this.tileSet.dictionary_lookups[field]) {
      if (typeof (k) === 'string') { continue; }
      const col = Math.floor(k / 64);
      const row = (k % 64);
      const step = width / 64;
      let score = 0;
      let overflown = false;
      for (const j of range(step)) {
        for (const i of range(step)) {
          const value = minilist[
            col * step * 4 + i * 4 // column
          + row * step * 4 * width + j * width * 4 // row
          + 3];
          // Can't be sure that we've got precision up above half precision.
          // So for factors with > 128 items, count them manually.
          if (value >= 128) {
            overflown = true;
            continue;
          }
          score += value;
        }
      }
      if (!overflown) {
      // The cells might be filled up at 128;
        counts.set(v, score);
      } else {
        console.log(k, v, 'overflown, performing manually');
        counts.set(v, this.n_visible(k));
      }
      //        console.log(k, v, col, row, score)
    }
    return counts;
  }

  n_visible(only_color = -1) {
    let { width, height } = this;
    width = Math.floor(width);
    height = Math.floor(height);
    this.contour_vals = this.contour_vals || new Uint8Array(4 * width * height);

    const { props } = this;
    props.only_color = only_color;
    let v;
    this.fbos.contour.use(() => {
      this.regl.clear({ color: [0, 0, 0, 0] });
      // read onto the contour vals.
      this.render_points(props);
      this.regl.read(this.contour_vals);
      // Could be done faster on the GPU itself.
      // But would require writing to float textures, which
      // can be hard.
      v = sum(this.contour_vals);
    });
    return v;
  }

  /*
  calculate_contours(field = 'lc0') {
    const { width, height } = this;
    const ix = 16;
    let contour_set = [];
    const contour_machine = contours()
      .size([parseInt(width), parseInt(height)])
      .thresholds(range(-1, 9).map((p) => Math.pow(2, p * 2)));

    for (const ix of range(this.tileSet.dictionary_lookups[field].size / 2)) {
      this.draw_contour_buffer(field, ix);
      // Rather than take the fourth element of each channel, I can use
      // a Uint32Array view of the data directly since rgb channels are all
      // zero. This just gives a view 256 * 256 * 256 larger than the actual numbers.
      const my_contours = contour_machine(this.contour_alpha_vals);
      //    console.log(sum(this.contour_alpha_vals))
      my_contours.forEach((d) => {
        d.label = this.tileSet.dictionary_lookups[field].get(ix);
      });
      contour_set = contour_set.concat(my_contours);
    }
    return contour_set;
  }
  */
  color_pick(x, y) {
    const { props, height } = this;

    props.color_picker_mode = 1;

    let color_at_point;

    this.fbos.colorpicker.use(() => {
      this.regl.clear({ color: [0, 0, 0, 0] });

      // read onto the contour vals.
      this.render_points(props);
      // Must be flipped
      try {
        color_at_point = this.regl.read({
          x, y: height - y, width: 1, height: 1,
        });
      } catch (err) {
        console.warn('Read bad data from', {
          x, y, height, attempted: height - y,
        });
        color_at_point = [0, 0, 0, 0];
      }
    });

    // Subtract one. This inverts the operation `fill = packFloat(ix + 1.);`
    // in glsl/general.vert, to avoid off-by-one errors with the point selected.
    const point_as_float = unpackFloat(...color_at_point) - 1;

    // Coerce to int. unpackFloat returns float but findPoint expects int.
    const point_as_int = Math.round(point_as_float)
    const p = this.tileSet.findPoint(point_as_int);

    if (p.length === 0) { return undefined; }

    return p[0];
  }

  /* blur(fbo) {
  var passes = [];
  var radii = [Math.round(
    Math.max(1, state.bloom.radius * pixelRatio / state.bloom.downsample))];
  for (var radius = nextPow2(radii[0]) / 2; radius >= 1; radius /= 2) {
    radii.push(radius);
  }
  radii.forEach(radius => {
    for (var pass = 0; pass < state.bloom.blur.passes; pass++) {
      passes.push({
        kernel: 13,
        src: bloomFbo[0],
        dst: bloomFbo[1],
        direction: [radius, 0]
      }, {
        kernel: 13,
        src: bloomFbo[1],
        dst: bloomFbo[0],
        direction: [0, radius]
      });
    }
  })
} */
  get fill_buffer() {
    //
    if (!this._fill_buffer) {
      const { regl } = this;
      this._fill_buffer = regl.buffer(
        { data: [-4, -4, 4, -4, 0, 4] },
      );
    }
    return this._fill_buffer;
  }

  draw_contour_buffer(field, ix) {
    let { width, height } = this;
    width = Math.floor(width);
    height = Math.floor(height);

    this.contour_vals = this.contour_vals || new Uint8Array(4 * width * height);
    this.contour_alpha_vals = this.contour_alpha_vals || new Uint16Array(width * height);

    const { props } = this;

    props.aes.encoding.color = {
      field,
    };

    props.only_color = ix;

    this.fbos.contour.use(() => {
      this.regl.clear({ color: [0, 0, 0, 0] });
      // read onto the contour vals.
      this.render_points(props);
      this.regl.read(this.contour_vals);
      console.log(
        this.contour_vals.filter((d) => d !== 0)
          .map((d) => d / 6).reduce((a, b) => a + b, 0),
      );
    });

    // 3-pass blur
    this.blur(this.fbos.contour, this.fbos.ping, 3);

    this.fbos.contour.use(() => {
      this.regl.read(this.contour_vals);
      console.log(
        this.contour_vals.filter((d) => d != 0)
          .map((d) => d / 6)
          .reduce((a, b) => a + b, 0),
      );
    });

    let i = 0;

    while (i < width * height * 4) {
      this.contour_alpha_vals[i / 4] = this.contour_vals[i + 3] * 255;
      i += 4;
    }
    return this.contour_alpha_vals;
  }

  remake_renderer() {
    console.log('Remaking renderers');

    const { regl } = this;
    // This should be scoped somewhere to allow resizing.

    const parameters = {
      depth: { enable: false },
      stencil: { enable: false },
      blend: {
        enable(_, { color_picker_mode }) { return color_picker_mode < 0.5; },
        func: {
          srcRGB: 'one',
          srcAlpha: 'one',
          dstRGB: 'one minus src alpha',
          dstAlpha: 'one minus src alpha',
        },
      },
      primitive: 'points',
      frag: frag_shader,
      vert: vertex_shader,
      count(_, props) {
        return props.manager.count;
      },
      attributes: {
        buffer_0: (_, props) => props.manager.regl_elements.get('ix'),
      }, // Filled below.
      uniforms: {
        u_update_time: regl.prop('update_time'),
        u_transition_duration(_, props) {
        // const fraction = (props.time)/props.prefs.duration;
          return props.prefs.duration;
        },
        u_only_color(_, props) {
          if (props.only_color !== undefined) {
            return props.only_color;
          }
          // Use -2 to disable color plotting. -1 is a special
          // value to plot all.
          // Other values plot a specific value of the color-encoded field.
          return -2;
        },
        u_use_glyphset: (_, { prefs }) => (prefs.glyph_set ? 1 : 0),
        u_glyphset: (_, { prefs }) => {
          if (prefs.glyph_set) {
            return this.get_image_texture(prefs.glyph_set);
          }
          return this.fbos.empty_texture;
        },
        u_color_picker_mode: regl.prop('color_picker_mode'),
        u_position_interpolation_mode() {
        // 1 indicates that there should be a continuous loop between the two points.
          if (this.aes.position_interpolation) {
            return 1;
          }
          return 0;
        },
        u_grid_mode: (_, { grid_mode }) => grid_mode,
        u_colors_as_grid: regl.prop('colors_as_grid'),

        u_constant_color: () => (this.aes.color.current.constant !== undefined
          ? this.aes.color.current.constant
          : [-1, -1, -1]),
        u_constant_last_color: () => (this.aes.color.last.constant != undefined
          ? this.aes.color.last.constant
          : [-1, -1, -1]),

        u_width: ({ viewportWidth }) => viewportWidth,
        u_height: ({ viewportHeight }) => viewportHeight,
        u_aspect_ratio: ({ viewportWidth, viewportHeight }) => viewportWidth / viewportHeight,
        u_zoom_balance: regl.prop('zoom_balance'),
        u_base_size: (_, { prefs }) => prefs.point_size,
        u_maxix: (_, props) => props.max_ix,
        u_k(_, props) {
          return props.transform.k;
        },
        // Allow interpolation between different coordinate systems.
        u_window_scale: regl.prop('webgl_scale'),
        u_last_window_scale: regl.prop('last_webgl_scale'),
        u_time: ({ time }) => time,
        u_filter1_numeric() {
          return this.aes.filter1.current.ops_to_array();
        },
        u_last_filter1_numeric() {
          return this.aes.filter1.last.ops_to_array();
        },
        u_filter2_numeric() {
          return this.aes.filter2.current.ops_to_array();
        },
        u_last_filter2_numeric() {
          return this.aes.filter2.last.ops_to_array();
        },
        u_current_alpha: () => this.optimal_alpha,
        u_last_alpha: () => this.optimal_alpha,
        u_jitter: () => this.aes.jitter_radius.current.jitter_int_format,
        u_last_jitter: () => this.aes.jitter_radius.last.jitter_int_format,
        u_zoom(_, props) {
          return props.zoom_matrix;
        },
      },
    };

    // store needed buffers
    for (const i of range(0, 16)) {
      parameters.attributes[`buffer_${i}`] = (_, { manager, buffer_num_to_variable }) => {
        const c = manager.regl_elements.get(buffer_num_to_variable[i]);
        return c || { constant: 0 };
      };
    }

    for (const k of ['x', 'y', 'color', 'jitter_radius',
      'jitter_speed', 'size', 'filter1', 'filter2', 'character', 'x0', 'y0']) {
      for (const time of ['current', 'last']) {
        const temporal = time === 'current' ? '' : 'last_';
        parameters.uniforms[`u_${temporal}${k}_map`] = () => this.aes[k][time].textures.one_d;
        parameters.uniforms[`u_${temporal}${k}_needs_map`] = () => this.aes[k][time].use_map_on_regl;
        // Currently, a texture lookup is only used for dictionaries.
        /* db join code
        if (k === 'jitter_radius' && temporal === '') {
          const base_string = `u_${temporal}${k}_lookup`;

          parameters.uniforms[base_string] = () =>
          // return 1;
            (this.aes[k][time].use_lookup ? 1 : 0);

          parameters.uniforms[`${base_string}_map`] = () => this.aes[k][time].lookup_texture.texture;
          parameters.uniforms[`${base_string}_y_constant`] = () => +this.aes[k][time].lookup_texture.value || 0.5;
          parameters.uniforms[`${base_string}_y_domain`] = () => this.aes[k][time].lookup_texture.y_domain;
          parameters.uniforms[`${base_string}_z_domain`] = () => this.aes[k][time].lookup_texture.z_domain;
          parameters.uniforms[`${base_string}_x_domain`] = () => this.aes[k][time].lookup_texture.x_domain;
        }
        */
        parameters.uniforms[`u_${temporal}${k}_domain`] = () => this.aes[k][time].domain;

        if (k !== 'color') {
          parameters.uniforms[`u_${temporal}${k}_range`] = () => this.aes[k][time].range;
        }

        parameters.uniforms[`u_${temporal}${k}_transform`] = () => {
          const t = this.aes[k][time].transform;
          if (t === 'linear') return 1;
          if (t === 'sqrt') return 2;
          if (t === 'log') return 3;
          if (t === 'literal') return 4;
          throw 'Invalid transform';
        };

        parameters.uniforms[`u_${temporal}${k}_constant`] = () => {
          if (this.aes[k][time].constant !== undefined) {
            return this.aes[k][time].constant;
          }
          return this.aes[k][time].default_val;
        };

        parameters.uniforms[`u_${temporal}${k}_buffer_num`] = (_, { aes_to_buffer_num }) => {
          const val = aes_to_buffer_num[`${k}--${time}`];
          if (val === undefined) { return -1; }
          return val;
        };
      }
    // Copy the parameters from the data name.
    }
    this._renderer = regl(parameters);
    return this._renderer;
  }

  allocate_aesthetic_buffers() {
    // There are only 15 attribute buffers available to use,
    // once we pass in the index. The order here determines
    // how important it is to capture transitions for them.

    const buffers = [];
    const priorities = ['x', 'y', 'color', 'size', 'jitter_radius',
      'jitter_speed', 'character', 'x0', 'y0', 'filter1', 'filter2'];

    for (const aesthetic of priorities) {
      for (const time of ['current', 'last']) {
        if (this.aes[aesthetic]) {
          if (this.aes[aesthetic][time].field) {
            buffers.push({ aesthetic, time, field: this.aes[aesthetic][time].field });
          }
        }
      }
    }

    buffers.sort((a, b) => {
      // Current values always come first.
      if (a.time < b.time) { return -1; } // current < last.
      if (b.time < a.time) { return 1; }
      return priorities.indexOf(a.aesthetic) - priorities.indexOf(b.aesthetic);
    });

    const aes_to_buffer_num = {}; // eg 'x' => 3

    // Pre-allocate the 'ix' buffer.
    const variable_to_buffer_num = { ix: 0 }; // eg 'year' =>  3
    let num = 0;
    for (const { aesthetic, time, field } of buffers) {
      const k = `${aesthetic}--${time}`;
      if (variable_to_buffer_num[field] !== undefined) {
        aes_to_buffer_num[k] = variable_to_buffer_num[field];
        continue;
      }
      if (num++ < 16) {
        aes_to_buffer_num[k] = num;
        variable_to_buffer_num[field] = num;
        continue;
      } else {
        // Don't use the last value, use the current value.
        aes_to_buffer_num[k] = aes_to_buffer_num[`${aesthetic}--current`];
      }
    }
    const buffer_num_to_variable = [...Object.keys(variable_to_buffer_num)];
    return { aes_to_buffer_num, variable_to_buffer_num, buffer_num_to_variable };
  }

  get discard_share() {
    // If jitter is temporal, e.g., or filters are in place,
    // it may make sense to estimate the number of hidden points.
    return 0;
  }
}

class TileBufferManager {
// Handle the interactions of a tile with a regl state.

  // binds elements directly to the tile, so it's safe
  // to re-run this multiple times on the same tile.
  constructor(regl, tile, renderer) {
    this.tile = tile;
    this.regl = regl;
    this.renderer = renderer;
    tile._regl_elements = tile._regl_elements || new Map();
    this.regl_elements = tile._regl_elements;
  }

  ready(prefs, block_for_buffers = true) {
    const { renderer, regl_elements } = this;
    const { aes } = renderer;
    if (!aes.is_aesthetic_set) {
      throw 'Aesthetic must be an aesthetic set';
    }
    let keys = [...Object.entries(aes)];
    keys = keys
      .map(([k, v]) => {
        if (aesthetic_variables.indexOf(k) === -1) {
          return [];
        }
        const needed = [];
        for (const aesthetic of [v.current, v.last]) {
          if (aesthetic.field) needed.push(aesthetic.field);
        }
        return needed;
      })

      .flat();

    for (const key of keys.concat(['ix'])) {
      const current = this.regl_elements.get(key);
      if (current === null) {
      // It's in the process of being built.
        return false;
      } if (current === undefined) {
        if (!this.tile.ready) {
        // Can't build b/c no tile ready.
          return false;
        }
        // Request that the buffer be created before returning false.
        regl_elements.set(key, null);
        if (block_for_buffers) {
          this.create_regl_buffer(key);
        } else {
          renderer.deferred_functions.push(() => this.create_regl_buffer(key));
          return false;
        }
      }
    }
    return true;
  }

  get count() {
    const { tile, regl_elements } = this;
    if (regl_elements.has('_count')) {
      return regl_elements.get('_count');
    }
    if (tile.ready) {
      regl_elements.set('_count', tile.table.length);
      return regl_elements.get('_count');
    }
  }
  /*
  create_position_buffer() {
    const { table } = this.tile;
    const x = table.getColumn('x').data.values;
    const y = table.getColumn('y').data.values;
    const buffer = new Float32Array(this.count * 2);
    for (let i = 0; i < this.count; i += 1) {
      buffer[i * 2] = x[i];
      buffer[i * 2 + 1] = y[i];
    }
    return buffer;
  } */

  create_buffer_data(key) {
    const { tile } = this;
    if (!tile.ready) {
      throw 'Tile table not present.';
    }
    const column = tile.table.getColumn(`${key}_dict_index`) || tile.table.getColumn(key);

    /* if (key == 'position') {
      console.warn('CREATING POSITION BUFFER (DEPRECATED)');
      return this.create_position_buffer();
    } */

    if (!column) {
      const col_names = tile.table.schema.fields.map((d) => d.name);
      throw `Requested ${key} but table has columns ${col_names.join(', ')}`;
    }

    if (column.dictionary) {
      const buffer = new Float32Array(tile.table.length);
      let row = 0;
      for (const val of column.data.values) {
        const char_value = tile.local_dictionary_lookups[key].get(val);
        buffer[row] = tile.dictionary_lookups[key].get(char_value);
        row += 1;
      }
      return buffer;
    } if (column.data.values.constructor !== Float32Array) {
      const buffer = new Float32Array(tile.table.length);
      for (let i = 0; i < tile.table.length; i++) {
        buffer[i] = column.data.values[i];
      }
      return buffer;
    }
    // For numeric data, it's safe to simply return the data straight up.
    return column.data.values;
  }

  create_regl_buffer(key) {
    const { regl, regl_elements } = this;

    const data = this.create_buffer_data(key);
    const item_size = 4;
    const data_length = data.length;

    const buffer_desc = this.renderer.buffers.allocate_block(
      data_length, item_size,
    );

    regl_elements.set(
      key,
      buffer_desc,
    );
    //    if (key === 'ix') {console.warn(buffer_desc)}
    buffer_desc.buffer.subdata(data, buffer_desc.offset);
  }
}

class MultipurposeBufferSet {
  constructor(regl, buffer_size) {
    this.regl = regl;
    this.buffer_size = buffer_size;
    this.buffers = [];
    // Track the ends in case we want to allocate smaller items.
    this.buffer_offsets = [];
    this.generate_new_buffer();
  }

  generate_new_buffer() {
  // Adds to beginning of list.
    if (this.pointer) { this.buffer_offsets.unshift(this.pointer); }
    this.pointer = 0;
    this.buffers.unshift(
      this.regl.buffer({
        type: 'float',
        length: this.buffer_size,
        usage: 'dynamic',
      }),
    );
  }

  allocate_block(items, bytes_per_item) {
  // Allocate a block of this buffer.
  // NB size is in **bytes**
    if (this.pointer + items * bytes_per_item > this.buffer_size) {
    // May lead to ragged ends. Could be smarter about reallocation here,
    // too.
      this.generate_new_buffer();
    }
    const value = {
    // First slot stores the active buffer.
      buffer: this.buffers[0],
      offset: this.pointer,
      stride: bytes_per_item,
    };
    this.pointer += items * bytes_per_item;
    return value;
  }
}
