///<reference path="tsd.d.ts" />
///<reference path='Facet.ts' />
var Historyjs: Historyjs = <any>History;

module PIC {
    interface ElasticResults {
        data: Object;
        from: number;
        hits: Array<any>;
        total: number;
        filters: String;
    }

    interface FacetMap {
        [ID: string]: Facet;
    }

    interface Bucket {
        doc_count: number
        key: string
    }

    export class StoredView {
            position = undefined;
            heading = undefined;
            pitch = undefined;
            roll = undefined;
            transform = undefined;

            save (camera:Cesium.Camera) {
                if(typeof camera === 'undefined') {
                    throw new Cesium.DeveloperError('camera is required');
                }

                this.position = Cesium.Cartesian3.clone(camera.positionWC, this.position);
                this.heading = camera.heading;
                this.pitch = camera.pitch;
                this.roll = camera.roll;
                this.transform = Cesium.Matrix4.clone(camera.transform, this.transform);
            }

            load (camera:Cesium.Camera) {
                if(typeof this.position === 'undefined') {
                    throw new Cesium.DeveloperError('no view has been stored');
                }

                camera.position = Cesium.Cartesian3.clone(this.position, camera.position);
                camera.heading = this.heading;
                camera.pitch = this.pitch;
                camera.roll = this.roll;
                camera.transform = Cesium.Matrix4.clone(this.transform, camera.transform);
            }
    }

    export class PIC {
        viewer : Cesium.Viewer;
        scene : Cesium.Scene;
        camera : Cesium.Camera;
        lastCameraViewMatrix : Cesium.Matrix4 = new Cesium.Matrix4();
        lastCameraMoveTime = 0;
        verboseRendering = true;
        stoppedRendering = false;
        canvas;
        points;
        handler;
        elasticResults : ElasticResults = {data: {}, from: 0, hits:[], total:0, filters:""};
        pointArray = [];
        pointHash = {}; // contains the index to a given id in the pointArray
        latlonHeightHash = {};
        heightHash = {};
        allIDs = [];
        lines;
        hasWebGL:boolean = false

        storedView: StoredView = new StoredView();

        adminMode = false;

        bounds;
        totalPhotographers = 0;

        elasticSize = 10000;
        padding = 0.01; // to extend the boundary a bit
        maxExport = 100;
        resultLimit = 50;
        heightDelta = 100;
        lineWidth = 2;
        pixelSize = 4;
        pixelScale = 4;
        farScale = 1.0;
        nearScale = 0.1;
        zoomIncrement = 3
        minHeight = 200
        generalMargin = 10;
        defaultValue = "*";

        nullIsland: any;
        boundsFrom: Cesium.Cartographic;
        boundsTo: Cesium.Cartographic;
        boundsSelectionEntity: Cesium.Entity;
        boundsPrimitive: Cesium.Primitive;
        isDrawing = false;
        isPenDown = false;
        spaceLayer : Cesium.ImageryLayer;
        moonLayer : Cesium.ImageryLayer;
        spaceCircle : Cesium.Primitive;
        moonCircle : Cesium.Primitive;
        textLabels : Cesium.LabelCollection;

        minYear = 0;
        maxYear = new Date().getFullYear();
        spaceHeight = 400000;
        moonHeight = 3850000;
        spaceRadius =  850000.0;
        moonRadius =  700000.0;

        debug = false;

        minimizedWidth = "60px";
        facetsWidth = "20%";
        resultsWidth = "30%";
        facetsMinimized = false;
        mapMinimized = false;
        resultsMinimized = false;

        pickedEntity;
        mousePosition;
        startMousePosition;
        lastQuery;

        rootPath = '';

        tileUrl = '';
        mapboxKey = '';
        mapboxMap = '';
        baseUrl = '';
        geonamesUrl = '';
        bingMapsKey = '';
        nullIslandPath = '';
        meliesMoonPath = '';
        meliesSpacePath = '';
        authHeader = '';
        geoJsonPrefix = '';

        resultsElement;
        facetsElement;
        spinner;

        nameQueryElement = "nameQuery";
        fromDateElement = "fromDate";
        toDateElement = "toDate";

        facets : string[][] = [
            ["addresstypes", "Type", "AddressTypeID", "AddressType", "address"],
            ["countries", "Country", "CountryID", "Country", "address"],
            ["bbox", "In Map Area", "bbox", "", ""],
            ["nationalities", "Nationality", "Nationality", "Nationality", ""],
            ["genders", "Gender", "TermID", "Term", "gender"],
            ["processes", "Process", "TermID", "Term", "process"],
            ["roles", "Role", "TermID", "Term", "role"],
            ["formats", "Format", "TermID", "Term", "format"],
            ["biographies", "Source", "TermID", "Term", "biography"],
            ["collections", "Collections", "TermID", "Term", "collection"],
            [this.nameQueryElement, "", "DisplayName", "", ""],
            ["date", "", "Date", "", ""],
        ];

        facetValues = {};
        filters = {};
        facetWidgets: FacetMap = {};

        start : number;

        historyState : HistoryState;

        selectedColor = new Cesium.Color(1, 1, 0.2, 1);
        bizColor = new Cesium.Color(1, 0.50, 0.01, 1);
        birthColor = new Cesium.Color(0.30, 0.68, 0.29, 1);
        diedColor = new Cesium.Color(0.21, 0.49, 0.72, 1);
        activeColor = new Cesium.Color(0.89, 0.10, 0.10, 1);
        unknownColor = new Cesium.Color(1, 0.01, 1, 1);
        invisibleColor = new Cesium.Color(1, 1, 1, 0);

        addressTypePalette = {
            "2": this.bizColor, // biz
            "5": this.birthColor, // birth
            "6": this.diedColor, // death
            "7": this.activeColor, // active
            "1": this.unknownColor, // unknown
        };

        constructor() {
        }

        processStateChange () {
            this.notifyRepaintRequired();
            this.historyState = Historyjs.getState();

            // console.log("state:",this.historyState.data,Object.getOwnPropertyNames(this.historyState.data).length)

            // console.log(this.elasticResults)

            // change of view?

            if (this.historyState.data.ignore) {
                return;
            }

            var filterString = decodeURI(this.historyState.hash.substr(this.historyState.hash.lastIndexOf("/")+2));

            if (filterString.lastIndexOf("#") !== -1) filterString = filterString.substring(0, filterString.lastIndexOf("#"));

            // console.log("str:", filterString, "hist:", this.historyState);

            var keyVals = filterString.split("&");

            // console.log(filterString);
            // console.log(keyVals);

            for (var filter in keyVals) {
                var pair = keyVals[filter].split("=");

                if (pair[0] === "mode") {
                    var mode = Number(pair[1])
                    this.changeViewTo(mode)
                    continue
                }

                // find the facet this belongs to
                var key = pair[0] + ".";
                var key1 = key.substring(0, key.indexOf("."));
                var key2 = key.substring(key.indexOf(".") + 1, key.lastIndexOf(".")).replace(".", "");
                if (key2 == "") {
                    key2 = key1;
                    key1 = "";
                }
                var facet = this.facetWithKeyPair(key1, key2);
                if (facet === -1) {
                    // some other thing such as camera view
                    // console.log("other", pair[0], pair[1]);
                } else {
                    // update the filter itself
                    this.filters[pair[0]] = pair[1];
                    // now update the widget
                    var widget = this.facetWidgets[facet[0]];
                    // console.log(key, key1, key2, facet, widget);
                }
                if (widget) {
                    if (pair[0] != "bbox") {
                        widget.setValue(pair[1]);
                    } else {
                        // console.log("pair", pair);
                        if (this.boundsPrimitive) this.scene.primitives.remove(this.boundsPrimitive);
                        if (pair[1] !== "*") {
                            var eswnArray = pair[1].split("_");
                            var west = Number(eswnArray[0]);
                            var south = Number(eswnArray[1]);
                            var east = Number(eswnArray[2]);
                            var north = Number(eswnArray[3]);
                            var bbox = [Cesium.Cartographic.fromDegrees(north,west), Cesium.Cartographic.fromDegrees(south,east)];
                            this.setBboxWidget(bbox);
                            this.drawBounds(north, south, east, west);
                        }
                    }
                } else {
                    // date, place or name
                    if (pair[0] == "DisplayName") {
                        var str = "";
                        var rawName = pair[1];
                        rawName = rawName.replace(/[\(\)]/ig, "");
                        rawName = rawName.replace(/~4/g, "");
                        rawName = rawName.replace(/\*/g, "");
                        var isNumeric = !isNaN(Number(rawName));
                        if (pair[1] != "*" && !isNumeric) {
                            var names = rawName.split(" AND ");
                            str = names.join(" ");
                        } else if (isNumeric) {
                            str = rawName;
                        }
                        $("#" + this.nameQueryElement).val(str);
                    } else if (pair[0] == "Date") {
                        var from = this.minYear.toString();
                        var to = this.maxYear.toString();
                        if (pair[1] != "*") {
                            var rawDate = pair[1];
                            rawDate = rawDate.replace(/[\[\]]/ig, "");
                            var dates = rawDate.split(" TO ");
                            from = dates[0];
                            to = dates[1];
                        }
                        $("#" + this.fromDateElement).val(from);
                        $("#" + this.toDateElement).val(to);
                    }
                }
            }

            this.changeState();
        }

        init() {
            this.resultsElement = $("#constituents");
            this.facetsElement = $("#facets");
            this.getFacets();
            this.resetBounds();
            this.initWorld();
            this.loadBaseData();
            this.initMouseHandler();
            this.initListeners();
            // url history management
            $("#cesiumContainer").on("overlays:ready", (e) => {
                var state = Historyjs.getState();
                console.log(state.hash);
                
                if (state.hash == "/") {
                    this.displayBaseData();
                    this.applyFilters();
                } else {
                    this.processStateChange();
                }
            });
            Historyjs.Adapter.bind(window, 'statechange', () => {
                this.processStateChange();
            });
            var _bindRepaint = this.notifyRepaintRequired.bind(this);
            window.onresize = _bindRepaint;
            window.onclick = _bindRepaint;
            this.showSpinner(this.resultsElement);
            if (!this.hasWebGL) return
            this.scene.postRender.addEventListener( (e) => {this.postRender()} );
            this.canvas.addEventListener('mousemove', _bindRepaint, false);
            this.canvas.addEventListener('mousedown', _bindRepaint, false);
            this.canvas.addEventListener('mouseup', _bindRepaint, false);
            this.canvas.addEventListener('touchstart', _bindRepaint, false);
            this.canvas.addEventListener('touchend', _bindRepaint, false);
            this.canvas.addEventListener('touchmove', _bindRepaint, false);
            // Detect available wheel event
            var _wheelEvent = undefined;
            if ('onwheel' in this.canvas) {
                // spec event type
                _wheelEvent = 'wheel';
            } else if (Cesium.defined(document.onmousewheel)) {
                // legacy event type
                _wheelEvent = 'mousewheel';
            } else {
                // older Firefox
                _wheelEvent = 'DOMMouseScroll';
            }
            this.canvas.addEventListener(_wheelEvent, _bindRepaint, false);
        }

        toggleHelp () {
            $("#map-help").fadeToggle();
        }

        resetBounds () {
            this.bounds = [-180, -90, 180, 90];
        }

        initWorld () {
            if (!this.hasWebGL) return
            Cesium.BingMapsApi.defaultKey = this.bingMapsKey;
            this.viewer = new Cesium.Viewer('cesiumContainer', {
                imageryProvider: new Cesium.MapboxImageryProvider({
                    url: this.tileUrl,
                    mapId: this.mapboxMap,
                    accessToken: this.mapboxKey
                })

                // ,clock: new Cesium.Clock({shouldAnimate:false})
                // ,geocoder: false
                ,baseLayerPicker: false
                ,homeButton : false
                ,infoBox : false
                ,timeline : false
                ,animation : false
                ,navigationHelpButton : false
                ,navigationInstructionsInitiallyVisible : false
                ,mapProjection : new Cesium.WebMercatorProjection()
                ,creditContainer : "credits"
                ,selectionIndicator : false
                ,skyBox : false
                ,sceneMode : Cesium.SceneMode.SCENE3D
            });

            this.scene = this.viewer.scene;
            this.canvas = this.viewer.canvas;
            this.camera = this.viewer.camera;

            this.addNullIsland();

            this.spaceCircle = new Cesium.Primitive();
            this.scene.primitives.add(this.spaceCircle);

            this.moonCircle = new Cesium.Primitive();
            this.scene.primitives.add(this.moonCircle);

            this.textLabels = new Cesium.LabelCollection();
            this.scene.primitives.add(this.textLabels);

            this.showMoon();
            this.updateTextLabels();

            this.points = this.scene.primitives.add(new Cesium.PointPrimitiveCollection());
            this.points._rs = Cesium.RenderState.fromCache({
              depthTest : {
                enabled : true
              },
              depthMask : false,
              blending : Cesium.BlendingState.ADDITIVE_BLEND
            });

            this.lines = new Cesium.Primitive();
            this.scene.primitives.add(this.lines);

            this.boundsSelectionEntity = new Cesium.Entity();
            this.boundsSelectionEntity.rectangle = this.makeBoundsRect(Cesium.Cartographic.fromDegrees(0,0),Cesium.Cartographic.fromDegrees(0.1,0.1));
            this.viewer.entities.add(this.boundsSelectionEntity);
            this.boundsSelectionEntity.show = false;

            this.boundsPrimitive = new Cesium.Primitive();
            this.scene.primitives.add(this.boundsPrimitive);
        }

        showMoon () {
            // this.spaceLayer = new Cesium.Primitive({
            //     geometryInstances: new Cesium.GeometryInstance({
            //         geometry: new Cesium.RectangleGeometry({
            //             rectangle: Cesium.Rectangle.fromDegrees(-122.4190541, -48.4356558, -93.1480924, -31.0020460),
            //             height: this.spaceHeight - 1000
            //         })
            //     }),
            //     appearance: this.imageAppearance(this.meliesSpacePath)
            // });
            // this.scene.primitives.add(this.spaceLayer);

            // this.moonLayer = new Cesium.Primitive({
            //     geometryInstances: new Cesium.GeometryInstance({
            //         geometry: new Cesium.RectangleGeometry({
            //             rectangle: Cesium.Rectangle.fromDegrees(-122.4190541, -48.4356558, -93.1480924, -31.0020460),
            //             height: this.moonHeight - 1000
            //         })
            //     }),
            //     appearance: this.imageAppearance(this.meliesMoonPath)
            // });

            // this.scene.primitives.add(this.moonLayer);
            // moon._rs = Cesium.RenderState.fromCache({
            //     depthTest : {
            //         enabled: true
            //     },
            //     depthMask: true
            // });

            this.scene.primitives.remove(this.spaceCircle);
            this.scene.primitives.remove(this.moonCircle);
            this.textLabels.removeAll();

            this.viewer.imageryLayers.remove(this.moonLayer);
            this.moonLayer = this.viewer.imageryLayers.addImageryProvider(new Cesium.SingleTileImageryProvider({
                url : this.meliesMoonPath,
                rectangle : Cesium.Rectangle.fromDegrees(-122.4190541, -48.4356558, -93.1480924, -31.0020460)
            }));

            this.viewer.imageryLayers.remove(this.spaceLayer);
            this.spaceLayer = this.viewer.imageryLayers.addImageryProvider(new Cesium.SingleTileImageryProvider({
                url : this.meliesSpacePath,
                rectangle : Cesium.Rectangle.fromDegrees(-122.4190541, -48.4356558, -93.1480924, -31.0020460)
            }));

            this.moonLayer.alpha = 0.5;
            this.spaceLayer.alpha = 0.75;
        }

        hideMoon () {
            // this.scene.primitives.remove(this.spaceLayer);
            // this.scene.primitives.remove(this.moonLayer);
            this.viewer.imageryLayers.remove(this.moonLayer);
            this.viewer.imageryLayers.remove(this.spaceLayer);
            this.showSpaceFloatingPrimitives();
        }

        clickMoon(position: Cesium.Cartesian2) {
            var cartesian = this.camera.pickEllipsoid(position, this.scene.globe.ellipsoid);
            if (cartesian === undefined) return;
            var cartographic = Cesium.Cartographic.fromCartesian(cartesian);
            var lat = Cesium.Math.toDegrees(cartographic.latitude).toFixed(4);
            var lon = Cesium.Math.toDegrees(cartographic.longitude).toFixed(4);
            console.log("\n%c clicked: %s,%s ", 'background: #222; color: #bada55; font-size: 28pt', lat.toString(), lon.toString());
            console.log(lat, lon);
        }

        showSpaceFloatingPrimitives () {
            this.scene.primitives.remove(this.spaceCircle);
            this.scene.primitives.remove(this.moonCircle);

            var xmin = -111.0687;
            var xmax = -101.8181;
            var dx = xmax - xmin;
            var ymin = -40.2230;
            var ymax = -33.9660;
            var dy = ymax - ymin;
            var centerx = xmin + dx * .2;
            var centery = ymin + dy * .2;

            // the space outline

            var spaceCircle = new Cesium.CircleOutlineGeometry({
                center : Cesium.Cartesian3.fromDegrees(centerx, centery),
                radius : this.spaceRadius,
                height : this.spaceHeight
            });

            var spaceGeometry = Cesium.CircleOutlineGeometry.createGeometry(spaceCircle);

            this.spaceCircle = new Cesium.Primitive({
                geometryInstances: new Cesium.GeometryInstance({
                geometry: spaceGeometry,
                attributes: {
                    color: Cesium.ColorGeometryInstanceAttribute.fromColor(Cesium.Color.WHITE.withAlpha(0.5))
                }
            }),
                appearance: new Cesium.PerInstanceColorAppearance({
                    flat : true,
                    renderState : {
                        lineWidth : Math.min(2.0, this.scene.maximumAliasedLineWidth)
                    }
                }),
                releaseGeometryInstances: false
            });

            this.scene.primitives.add(this.spaceCircle);

            // the moon outline
            var moonCircle = new Cesium.CircleOutlineGeometry({
                center : Cesium.Cartesian3.fromDegrees(centerx, centery),
                radius : this.moonRadius,
                height : this.moonHeight
            });

            var moonGeometry = Cesium.CircleOutlineGeometry.createGeometry(moonCircle);

            this.moonCircle = new Cesium.Primitive({
                geometryInstances: new Cesium.GeometryInstance({
                geometry: moonGeometry,
                attributes: {
                    color: Cesium.ColorGeometryInstanceAttribute.fromColor(Cesium.Color.WHITE.withAlpha(0.5))
                }
            }),
                appearance: new Cesium.PerInstanceColorAppearance({
                    flat : true,
                    renderState : {
                        lineWidth : Math.min(2.0, this.scene.maximumAliasedLineWidth)
                    }
                }),
                releaseGeometryInstances: false
            });

            this.scene.primitives.add(this.moonCircle);

            this.notifyRepaintRequired();
        }

        updateTextLabels () {
            var xmin = -111.0687;
            var xmax = -101.8181;
            var dx = xmax - xmin;
            var ymax = -33.9660;
            var centerx = xmin + dx * .2;

            this.textLabels.removeAll();

            if (this.scene.mode !== 2) {
                this.textLabels.add({
                    position : Cesium.Cartesian3.fromDegrees(centerx, ymax+3, this.spaceHeight),
                    text     : 'Outer Space',
                    font : '20px sans-serif',
                    horizontalOrigin : Cesium.HorizontalOrigin.LEFT,
                    translucencyByDistance : new Cesium.NearFarScalar(1.5e2, 1.0, 1.5e8, 0.1)
                });

                this.textLabels.add({
                    position : Cesium.Cartesian3.fromDegrees(centerx, ymax+1, this.moonHeight),
                    text     : 'The Moon!',
                    font : '20px sans-serif',
                    horizontalOrigin : Cesium.HorizontalOrigin.LEFT,
                    translucencyByDistance : new Cesium.NearFarScalar(1.5e2, 1.0, 1.5e8, 0.1)
                });
            }

            this.textLabels.add({
                position: Cesium.Cartesian3.fromDegrees(0.01, 0),
                text: 'Null Island',
                font: '12px sans-serif',
                horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
                translucencyByDistance: new Cesium.NearFarScalar(1.5e4, 1.0, 1.5e6, 0)
            });

            this.notifyRepaintRequired();
        }

        imageAppearance (imagePath: string) {
            return new Cesium.EllipsoidSurfaceAppearance({
                aboveGround : true,
                material: new Cesium.Material({
                    translucent: true,
                    fabric : {
                        type : 'Image',
                        uniforms : {
                            image : imagePath
                        }
                    }
                }),
                // renderState: {
                //     depthMask: false,
                //     depthTest: {
                //         enabled: true
                //     }
                // }
            });
        }

        randomPoints (n = 200) {
            for (var i = 0; i < n; i++) {
                this.randomPoint();
            }
        }

        randomPoint () {
            var bboxbig = "-118.6062_-46.6204_-99.3110_-31.6635";
            var bboxsml = "-116.4891_-45.0273_-101.4461_-33.1833";//-111.0687_-40.2230_-101.8181_-33.9660
            var phi = Math.random() * 2 * Math.PI;
            var rho = Math.random();
            rho = Math.random()*(1-0.823529412)+0.823529412;
            var x = Math.sqrt(rho) * Math.cos(phi);
            var y = Math.sqrt(rho) * Math.sin(phi);
            var xmin = -111.0687;
            var xmax = -101.8181;
            var dx = xmax - xmin;
            var ymin = -40.2230;
            var ymax = -33.9660;
            var dy = ymax - ymin;
            var centerx = xmin + dx * .2;
            var centery = ymin + dy * .2;
            var r = dy * .5;
            var px = centerx + x * r;
            var py = centery + y * r;
            var pt = Cesium.Cartesian3.fromDegrees(px, py, this.moonHeight);
            // console.log(px, py);
            this.points.add({
                    position : pt,
                    color: new Cesium.Color(1, 0.01, 1, 1),
                    pixelSize : this.pixelSize,
                    scaleByDistance : new Cesium.NearFarScalar(1.0e1, this.farScale, 8.0e6, this.nearScale)
                });
            this.notifyRepaintRequired();
        }

        makeBoundsRect (from:Cesium.Cartographic = Cesium.Cartographic.fromDegrees(0,0), to:Cesium.Cartographic = Cesium.Cartographic.fromDegrees(1,1)):Cesium.RectangleGraphics {
            return new Cesium.RectangleGraphics({
                coordinates: Cesium.Rectangle.fromCartographicArray([from, to]),
                outline: true,
                material: Cesium.Color.WHITE.withAlpha(0.0),
                outlineColor: Cesium.ColorGeometryInstanceAttribute.fromColor(Cesium.Color.WHITE.withAlpha(0.5)),
                outlineWidth: 2.0
            });
            // return new Cesium.Primitive({
            //     geometryInstances: new Cesium.GeometryInstance({
            //     geometry: new Cesium.RectangleOutlineGeometry({
            //         rectangle: Cesium.Rectangle.fromCartographicArray([from, to])
            //     }),
            //     attributes: {
            //         color: Cesium.ColorGeometryInstanceAttribute.fromColor(Cesium.Color.YELLOW.withAlpha(0.5))
            //     }
            // }),
            //     appearance: new Cesium.PerInstanceColorAppearance({
            //         flat : true,
            //         renderState : {
            //             lineWidth : Math.min(2.0, this.scene.maximumAliasedLineWidth)
            //         }
            //     }),
            //     releaseGeometryInstances: false
            // });
        }

        addNullIsland () {
            this.nullIsland = this.viewer.dataSources.add(Cesium.GeoJsonDataSource.load(this.nullIslandPath, {
                stroke: this.unknownColor,
                strokeWidth: 3,
                fill: this.invisibleColor,
                markerSymbol: '?'
            }));
        }

        loadBaseData () {
            // this.loadTextFile(this.rootPath + "csv/latlons.txt?i=" + Math.round(Math.random() * 100000000), function (responseText) {
            this.loadTextFile(this.rootPath + "csv/latlons.txt", function (responseText) {
                var baseData = JSON.parse(responseText)[1];
                this.parseBaseData(baseData);
            });
        }

        parseBaseData (baseData) {
            var i, l = baseData.length;
            this.allIDs = [];
            this.pointArray = [];
            for (i=0; i < l; i=i+6) {
                var id = baseData[i+3];
                var index = this.pointArray.push([
                    baseData[i],
                    baseData[i+1],
                    baseData[i+2],
                    id,
                    baseData[i+4],
                    baseData[i+5]
                ]);
                index = index - 1;
                this.pointHash[id] = index;
                this.allIDs.push(id);
            }

            // this.loadTextFile(this.rootPath + "csv/heights.txt?i=" + Math.round(Math.random() * 100000000), function(responseText) {
            this.loadTextFile(this.rootPath + "csv/heights.txt", function(responseText) {
                var heightData = JSON.parse(responseText)[1];
                this.parseHeightData(heightData);
            });
        }

        parseHeightData (heightData) {
            var i, l = heightData.length;
            for (i=0; i < l; i=i+2) {
                var id = heightData[i];
                var index = this.pointHash[id];
                if (this.pointArray[index] === undefined) continue;
                this.pointArray[index][6] = heightData[i+1];
            }
            $("#cesiumContainer").trigger("overlays:ready");
        }

        displayBaseData () {
            this.addPoints(this.allIDs);
            this.updateTotals(this.allIDs.length);
            this.enableFacets();
            this.updateBounds();
            this.showResults();
            // this.applyBaseAggregations()
        }

        applyAggregations (aggs) {
            // console.log(aggs)
            for (var agg in aggs) {
                var keypair = agg.split(".")
                var key = "", val = ""
                val = keypair[0]
                if (keypair.length > 1) {
                    key = val
                    val = keypair[1]
                }
                var facet = this.facetWithKeyPair(key, val)
                var widgetName = facet[0]
                var widget = this.facetWidgets[widgetName]
                widget.hideAll()
                if (aggs[agg].buckets && aggs[agg].buckets.length !== 0) {
                    // some items in this facet should be visible
                    var data = widget.data
                    var buckets:Array<Bucket> = aggs[agg].buckets
                    for (var thing in buckets) {
                        var bucket:Bucket = buckets[thing]
                        var count = bucket.doc_count
                        var item = bucket.key
                        widget.updateItemText(item, widget.data[item], count)
                        widget.showItem(item)
                    }
                }
                // console.log(agg, widgetName, aggs[agg].buckets)
            }
        }

        applyBaseAggregations () {
            // get aggregation data for empty search
            // for addresses only since base data includes a query for 50 results
            var filters = "hits.total,aggregations"
            // constituent aggs
            var data = this.buildElasticQuery(["ConstituentID:*"], ["*"], "parent")
            this.getData({filters:filters, data:data, docType:"address", sort:"", source:"", size:0, callback:function(results){
                if (results.aggregations) {
                    this.applyAggregations(results.aggregations)
                }
                var dataB = this.buildElasticQuery(["ConstituentID:*"], ["*"], "child")
                dataB.query.bool.must.pop() // hack to remove the has_child
                this.getData({filters:filters, data:dataB, source:"", size:0, callback:function(resultsB){
                    if (resultsB.aggregations) {
                        this.applyAggregations(resultsB.aggregations)
                    }
                }})
            }})
        }

        loadTextFile (url, callback, parameter = undefined) {
            var pic = this;

            var r = new XMLHttpRequest();

            r.open("GET", url, true);

            r.onreadystatechange = function () {
                if (r.readyState != 4 || r.status != 200) return;
                if (parameter === undefined) {
                    callback.apply(pic, [r.responseText]);
                } else {
                    callback.apply(pic, [r.responseText, parameter]);
                }
            };
            r.send();
        }

        getData({filters, data, callback, source, size = this.elasticSize, exclude = "", from = 0, parameter = undefined, docType = "constituent", sort = "AlphaSort.raw:asc"}) {
            var hasName = (this.buildFacetList().map( a => a.indexOf("DisplayName:") != -1 )).indexOf(true) != -1;
            // console.log(hasName);
            if (hasName) {
                sort = "_score," + sort;
            }
            var url = this.baseUrl //+ "?docType=" + docType + "&sort=" + sort;
            // url = url + "&filter_path="+filters;
            // url = url + "&size="+size;
            // url = url + "&from="+from;
            // url = url + "&_source="+source;
            // url = url + "&_source_exclude="+exclude;
            // console.log("elastic", url, JSON.stringify(data));
            var pic = this;

            var r = new XMLHttpRequest();

            r.open("POST", url, true);
            // r.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded; charset=UTF-8');
            r.setRequestHeader('Authorization', 'Basic ' + this.authHeader);
            r.setRequestHeader('Content-Type', 'application/json');
            // r.responseType = "json";
            r.onreadystatechange = function() {
                if (r.readyState != 4 || r.status != 200) return;
                // console.log("result", r.responseText);
                var res = JSON.parse(r.responseText)
                if (parameter === undefined) {
                    callback.apply(pic, [res]);
                } else {
                    callback.apply(pic, [res, parameter]);
                }
            };
            var req = {
                "q": data,
                "filter_path": filters,
                "size": size,
                "from": from,
                "source": source,
                "docType": docType,
                "sort": sort,
                "source_exclude": exclude
            }
            r.send(JSON.stringify(req));
        }

        parseInnerHits (results) {
            var parsed = {
                hits: {
                    total: results.hits.total,
                    hits: []
                }
            }
            for (var hit in results.hits.hits) {
                var tmp = {
                    _source: results.hits.hits[hit]._source
                }
                if (results.hits.hits[hit].inner_hits != undefined) {
                    // console.log(results.hits.hits[hit])
                    tmp._source.address = results.hits.hits[hit].inner_hits.address.hits.hits.map( a => a._source )
                }
                parsed.hits.hits.push(tmp)
            }
            return parsed
        }

        buildAggregations (type:string) {
            var aggs = {}
            for (var i=0; i < this.facets.length; i++) {
                var facet = this.facets[i]
                if (facet[3] != "") {
                    var name = facet[2]
                    if (facet[4] !== "") name = facet[4] + "." + name
                    if (type === "parent" && name.indexOf("address") === -1) {
                        continue
                    } else if (type === "child" && name.indexOf("address") !== -1) {
                        continue
                    }
                    aggs[name] = {
                        "terms": {
                            "field": name,
                            "size": 0
                        }
                    }
                }
            }
            return aggs//{ "aggregations" : aggs }
        }

        buildElasticQuery (normal:Array<string>, filter:Array<string>, type:string) {
            // console.log("buildEQ", normal, filter);

            var filterType = "has_child"
            if (type === "parent") {
                filterType = "has_parent"
            }

            var baseString = "*";
            var nestedString = "";
            var constituentArray = [];
            var addressArray = [];
            if (normal.length > 0) {
                for (var f in normal) {
                    if (normal[f].indexOf("address.") === -1) {
                        constituentArray.push(normal[f]);
                    } else {
                        addressArray.push(normal[f]);
                    }
                }
            }

            // console.log(constituentArray);
            // console.log(addressArray);

            var data = {};
            var nestedFilter = {};
            var nestedQuery = this.makeEmptyQuery(type);
            var hasNestedFilter = false;

            data["query"] = {
                "bool": {
                    "must": []
                }
            };

            if (constituentArray.length > 0) {
                baseString = "(" + constituentArray.join(" AND ") + ")";
                var query = { "query_string": { "query": baseString } };
                if (type === "child") {
                    // looking for constituents so baseQuery applies to main data
                    data["query"]["bool"]["must"].push(query);
                } else {
                    nestedQuery[filterType]["query"]["bool"]["must"].push(query);
                }
            }

            if (addressArray.length > 0) {
                nestedString = "(" + addressArray.join(" AND ") + ")";
                var query = { "query_string": { "query": nestedString } }
                if (type === "child") {
                    // looking for addresses
                    nestedQuery[filterType]["query"]["bool"]["must"].push(query);
                } else {
                    // looking for constituents so query applies to main data
                    data["query"]["bool"]["must"].push(query);
                }
            }

            if (filter.length !== 0 && filter[0].indexOf("*") === -1) {
                // TODO: for now the filter assumes only ["w|s|e|n"] or ["*"]
                var filterSplit = filter[0].split(":")

                var edgesArray = [];

                if (filterSplit.length === 2) edgesArray = filterSplit[1].split("_");

                if (filter[0] !== "*" && filter[0] !== "(*)" && edgesArray.length === 4) {
                    hasNestedFilter = true;
                    nestedFilter = {
                        "geo_bounding_box": {
                            "address.Location": {
                                "left": Number(edgesArray[0]),
                                "bottom": Number(edgesArray[1]),
                                "right": Number(edgesArray[2]),
                                "top": Number(edgesArray[3])
                            }
                        }
                    }
                }
            }


            if (hasNestedFilter) {
                if (type === "child") {
                    nestedQuery[filterType]["query"] = {
                        "filtered": {
                            "query": nestedQuery[filterType]["query"],
                            "filter": nestedFilter
                        }
                    }
                    data["query"]["bool"]["must"].push(nestedQuery)
                } else {
                    data["query"]["bool"]["must"].push(nestedQuery)
                    data = {
                        "query": {
                            "filtered": data
                        }
                    }
                    data["query"]["filtered"]["filter"] = nestedFilter
                }
            } else {
                data["query"]["bool"]["must"].push(nestedQuery)
            }

            data["aggregations"] = this.buildAggregations(type)

            return data
        }

        makeEmptyQuery (type:string) {
            var filter = "has_child", value = "address"
            if (type === "parent") {
                filter = "has_parent"
                value = "constituent"
            }
            var query = {}
            query[filter] = {
                "type": value,
                "query": {
                    "bool": {
                        "must": []
                    }
                }
            }
            return query
        }

        updateTotals (total) {
            // console.log("total", total, this.elasticResults);
            if (total === -1) total = this.elasticResults.total;
            $("#total-points").html("<span class=\"number\">" + total.toLocaleString() + "</span><br />" + this.humanizeFilters());
            this.resultsElement.find(".spinner").find(".text").remove();
            var photographerHTML = "<span class='text'>"
            photographerHTML += "<em>" + total.toLocaleString() + "</em><br />locations"
            if (this.totalPhotographers > 0) {
                photographerHTML += " for<br />" + this.totalPhotographers.toLocaleString() + "<br />constituents"
            }
            photographerHTML += "<br />loaded"
            photographerHTML += "</span>"
            this.resultsElement.find(".spinner").append(photographerHTML);
            this.notifyRepaintRequired();
        }

        updateBounds () {
            // console.log(bounds);
            if (!this.hasWebGL) return
            var west = this.bounds[2];
            var south = this.bounds[3];
            var east = this.bounds[0];
            var north = this.bounds[1];
            this.viewer.camera.flyTo({
                destination : Cesium.Rectangle.fromDegrees(west, south, east, north),
                duration : 1
            });
            this.notifyRepaintRequired();
        }

        minimizeFacets () {
            this.facetsMinimized = true;
            $("#facet-container").addClass("minimized");
            $("#facet-container .minimize").addClass("hidden");
            $("#facet-container .maximize").removeClass("hidden");
            this.updateLefts();
        }

        maximizeFacets () {
            this.facetsMinimized = false;
            $("#facet-container").removeClass("minimized");
            $("#facet-container .minimize").removeClass("hidden");
            $("#facet-container .maximize").addClass("hidden");
            this.updateLefts();
        }

        minimizeMap() {
            this.mapMinimized = true;
            $("#cesiumContainer").addClass("minimized");
            $(".cesium-viewer").addClass("hidden");
            $("#cesiumContainer .minimize").addClass("hidden");
            $("#cesiumContainer .maximize").removeClass("hidden");
            this.updateLefts();
        }

        maximizeMap() {
            this.mapMinimized = false;
            $(".cesium-viewer").removeClass("hidden");
            $("#cesiumContainer").removeClass("minimized");
            $("#cesiumContainer .minimize").removeClass("hidden");
            $("#cesiumContainer .maximize").addClass("hidden");
            this.updateLefts();
        }

        minimizeResults() {
            this.resultsMinimized = true;
            $("#constituents").addClass("minimized");
            $("#constituents .minimize").addClass("hidden");
            $("#constituents .maximize").removeClass("hidden");
            this.updateLefts();
        }

        maximizeResults() {
            this.resultsMinimized = false;
            $("#constituents").removeClass("minimized");
            $("#constituents .minimize").removeClass("hidden");
            $("#constituents .maximize").addClass("hidden");
            this.updateLefts();
        }

        updateLefts() {
            var resultLeft = "";
            var mapLeft = "";
            var resultWidth = "";
            var mapWidth = "";

            if (this.mapMinimized) {
                $("#constituents .minimize").addClass("hidden");
            } else if (!this.resultsMinimized) {
                $("#constituents .minimize").removeClass("hidden");
            }

            if (this.resultsMinimized) {
                $("#cesiumContainer .minimize").addClass("hidden");
            } else if (!this.mapMinimized) {
                $("#cesiumContainer .minimize").removeClass("hidden");
            }

            if (this.facetsMinimized) {
                resultLeft = this.minimizedWidth;
            } else {
                resultLeft = this.facetsWidth;
            }

            if (this.resultsMinimized) {
                resultWidth = this.minimizedWidth;
            } else {
                resultWidth = "calc(100% - (" + (this.facetsMinimized ? this.minimizedWidth : this.facetsWidth) + " + " + (this.mapMinimized ? this.minimizedWidth : this.facetsWidth + " + " + this.resultsWidth) + "))";
            }

            if (this.mapMinimized) {
                mapWidth = this.minimizedWidth;
                mapLeft = "calc(" + (this.resultsMinimized ? (this.facetsMinimized ? this.minimizedWidth + " * 2" : this.minimizedWidth + " + " + this.resultsWidth) : "100% - " + this.minimizedWidth) + ")";
            } else {
                mapWidth = "calc(100% - (" + (this.resultsMinimized ? (this.facetsMinimized ? this.minimizedWidth + " * 2" : this.facetsWidth + " + " + this.minimizedWidth) : this.facetsWidth + " + " + this.resultsWidth) + "))";
                if (this.resultsMinimized) {
                    if (this.facetsMinimized) {
                        mapLeft = "calc(" + this.minimizedWidth + " * 2)";
                    } else {
                        mapLeft = "calc(" + this.minimizedWidth + " + " + this.facetsWidth + ")";
                    }
                } else {
                    mapLeft = "calc(" + this.facetsWidth + " + " + this.resultsWidth + ")";
                }
            }

            if (resultLeft != "") $("#constituents").css("left", resultLeft);
            if (resultWidth != "") $("#constituents").css("width", resultWidth);

            if (mapLeft != "") $("#cesiumContainer").css("left", mapLeft);
            if (mapWidth != "") $("#cesiumContainer").css("width", mapWidth);
        }

        initMouseHandler() {
            var pic = this;

            if (!this.hasWebGL) return

            this.canvas.setAttribute('tabindex', '0'); // needed to put focus on the canvas

            // $("#facet-container, #constituents").mousemove( () => {
            //     this.positionHover(false);
            // } );

            // this.canvas.onclick = (e) => {
            //     this.canvas.focus();
            //     // console.log(mousePosition, startMousePosition, e);
            //     if (this.mousePosition != this.startMousePosition) return;
            //     var pickedObject = this.pickEntity({x:e.layerX, y:e.layerY});
            //     this.refreshPicked(pickedObject);
            // };
            this.viewer.screenSpaceEventHandler.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK)
            
            this.canvas.ondblclick = (e) => {
                console.log(e)
                var p = new Cesium.Cartesian2(e.layerX, e.layerY)
                if (!p) return
                var cartesian = this.camera.pickEllipsoid(p, this.scene.globe.ellipsoid)
                var height
                if (this.scene.mode !== 3) {
                    height = this.camera.getMagnitude() / this.zoomIncrement
                } else {
                    height = Cesium.Cartographic.fromCartesian(this.camera.positionWC).height / this.zoomIncrement
                }
                if (height <= this.minHeight) height = this.minHeight
                var destination =  this.scene.globe.ellipsoid.cartesianToCartographic(cartesian)
                console.log(p, cartesian, destination, height)
                this.camera.flyTo({
                    destination : Cesium.Cartesian3.fromRadians(destination.longitude, destination.latitude, height),
                    duration : 1.0
                })
                this.notifyRepaintRequired()
            }

            // this.canvas.onmousemove = this.canvas.ontouchmove = (e) => {
            //     var c = new Cesium.Cartesian2(e.layerX, e.layerY);
            //     if (!c) return;
            //     this.mousePosition = c;
            //     var pickedObject = this.scene.pick(c);
            //     this.refreshPicked(pickedObject);
            //     if (this.isDrawing) this.drawMove(c);
            // }

            // this.canvas.onmousedown = this.canvas.ontouchstart = (e) => {
            //     var c = new Cesium.Cartesian2(e.layerX, e.layerY);
            //     this.mousePosition = this.startMousePosition = c;
            //     if (this.isDrawing) this.drawStart(c);
            //     this.hideBoundsDialog();
            // }

            // this.canvas.onmouseup = this.canvas.ontouchend = (e) => {
            //     var c = new Cesium.Cartesian2(e.layerX, e.layerY);
            //     this.mousePosition = this.startMousePosition = c;
            //     if (this.isDrawing) this.drawEnd(c);
            //     if (this.adminMode) this.clickMoon(c);
            //     this.positionBoundsDialog(e.layerX, e.layerY);
            // }

        }

        positionBoundsDialog (x, y) {
            var bWidth = $("#bounds").width();
            var cWidth = $("#cesiumContainer").width();
            var xPx = x + "px";
            var yPx = y + "px";
            if (x + bWidth > cWidth) {
                xPx = (x - bWidth) + "px";
            }
            $("#bounds").css("top", yPx);
            $("#bounds").css("left", xPx);
        }

        showBoundsDialog () {
            $("#bounds").fadeIn(100);
        }

        hideBoundsDialog () {
            $("#bounds").hide();
        }

        applyBounds () {
            var widget = this.facetWidgets["bbox"];
            this.hideBoundsDialog();
            this.stopDrawing();
            this.updateFilter(widget.ID, widget.value);
            this.applyFilters();
        }

        cancelBounds () {
            var widget = this.facetWidgets["bbox"];
            widget.reset();
            this.initFacetWidget(widget);
            widget.init(); // hack... but works ¯\_(ツ)_/¯
            this.hideBoundsDialog();
            this.stopDrawing();
        }

        drawStart(position: Cesium.Cartesian2) {
            this.isPenDown = true;
            if (!position) return;
            var cartesian = this.camera.pickEllipsoid(position, this.scene.globe.ellipsoid);
            if (cartesian === undefined) return;
            var cartographic = Cesium.Cartographic.fromCartesian(cartesian);
            this.boundsTo = cartographic;
            this.boundsFrom = cartographic;
            this.boundsSelectionEntity.show = true;
            this.drawSelection();
        }

        drawEnd (position:Cesium.Cartesian2) {
            this.isPenDown = false;
            this.showBoundsDialog();
        }

        drawMove (position:Cesium.Cartesian2) {
            if (!this.isPenDown) return;
            if (!position) return;
            // console.log("drawmove pos", position);
            var cartesian = this.camera.pickEllipsoid(position, this.scene.globe.ellipsoid);
            if (cartesian === undefined) return;
            // console.log("drawmove cart", cartesian);
            var cartographic = Cesium.Cartographic.fromCartesian(cartesian);
            this.boundsTo = cartographic;
            this.setBboxWidget([this.boundsFrom,this.boundsTo]);
            this.drawSelection();
        }

        drawSelection () {
            if (this.boundsFrom != this.boundsTo) this.boundsSelectionEntity.rectangle = this.makeBoundsRect(this.boundsFrom, this.boundsTo);
            this.notifyRepaintRequired();
        }

        drawBounds (north:number, south:number, east:number, west:number) {
            this.scene.primitives.remove(this.boundsPrimitive);
            this.boundsPrimitive = new Cesium.Primitive({
                geometryInstances: new Cesium.GeometryInstance({
                geometry: new Cesium.RectangleOutlineGeometry({
                    rectangle: Cesium.Rectangle.fromDegrees(west, south, east, north)
                }),
                attributes: {
                    color: Cesium.ColorGeometryInstanceAttribute.fromColor(Cesium.Color.WHITE.withAlpha(0.5))
                }
            }),
                appearance: new Cesium.PerInstanceColorAppearance({
                    flat : true,
                    renderState : {
                        lineWidth : Math.min(2.0, this.scene.maximumAliasedLineWidth)
                    }
                }),
                releaseGeometryInstances: false
            });
            // this.boundsPrimitive = this.makeBoundsRect();
            this.scene.primitives.add(this.boundsPrimitive);
        }

        pickEntity (windowPosition) {
            var picked = this.scene.pick(windowPosition);
            if (picked !== undefined) {
                var id = Cesium.defaultValue(picked.id, picked.primitive.id);
                if (Cesium.defined(id)) {
                    return picked;
                }
            }
            return undefined;
        };

        refreshPicked (picked) {
            var showHover = false;
            if (this.isDrawing) return;
            if (Cesium.defined(picked) && picked.id &&  (picked.id.toString().indexOf("P_") === 0)) {
                if (this.pickedEntity === undefined || picked !== this.pickedEntity.entity) {
                    this.pickedEntity = {
                        color: Cesium.clone(picked.primitive.color),
                        entity: picked
                    };
                    this.buildHover();
                }
                showHover = true;
            } else {
                this.pickedEntity = undefined;
            }
            this.positionHover(showHover);
        }

        buildHover () {
            var position = this.pickedEntity.entity.primitive.originalLatlon;
            var filter = "hits.total";
            // TODO: fix hover query
            var query = '(address.Remarks:"' + position + '")';
            var facetList = this.buildFacetList();
            facetList.push(query);
            var data = this.buildFacetQuery(facetList);
            // console.log("hover", data);
            this.getData({filters:filter, data:data, callback:this.buildHoverContent, source:"", size:3});
        }

        buildHoverContent (data) {
            var el = $("#hover");
            if (this.pickedEntity === undefined) return;
            var position = this.pickedEntity.entity.primitive.originalLatlon;
            // console.log("hover", data);
            var hits = data.hits.total;
            var str = "<div>";
            str += '<span class="hits">' + hits.toLocaleString() + '</span>';
            str += hits === 1 ? " constituent" : " total constituents";
            str += " here";
            // if (hits > 1) str += " including";
            // if (hits > 0) str += " " + data.hits.hits.map(function(ob) { return ob._source.DisplayName }).join(", ");
            str += "<br /><span id='geoname'>&nbsp;</span>";
            str += "<br />Use <strong>In Map Area</strong> filter to select a region to display";
            str += "</div>";
            el.html(str);
            var latlon = position.split(",");
            var place;
            if (latlon.length === 3 && latlon[2] > 10000) {
                place = latlon[2] === "3850000" ? "in the Moon!" : "in Outer Space";
                this.updateHoverLocation(place);
                return;
            }
            if (latlon.length === 2 && latlon[0] === "0" && latlon[1] === "0") {
                place = "(placeholder location)";
                this.updateHoverLocation(place);
                return;
            }
            this.positionHover(true);
            var lat = parseFloat(latlon[0]);
            // var lon = parseFloat(latlon[1]);
            // var north = Math.round((lat+0.02) * 100) / 100;
            // var south = Math.round((lat-0.02) * 100) / 100;
            // var east = Math.round((lon+0.02) * 100) / 100;
            // var west = Math.round((lon-0.02) * 100) / 100;
            // // var reverseGeo = this.geonamesUrl + "&lat=" + latlon[0] + "&lng=" + latlon[1];
            // var reverseGeo = this.geonamesUrl + "&north=" + north + "&south=" + south + "&east=" + east + "&west=" + west;
            // // console.log(reverseGeo);
            // // TODO: only parse when mouse stopped moving
            // this.loadTextFile(reverseGeo, this.parseHoverLocation);
        }

        parseHoverLocation (data) {
            // console.log(data);
            if (!data.geonames) return;
            var geo = data.geonames[0];
            if (!geo) return;
            this.updateHoverLocation("near " + geo.name + ", " + geo.countrycode);
        }

        updateHoverLocation (text) {
            $("#geoname").text(text);
            this.positionHover(true);
        }

        positionHover (visible) {
            var el = $("#hover");
            var leftOffset = $("#cesiumContainer").position().left;
            var topOffset = $("#cesiumContainer").position().top;
            var margin = 5;
            if (this.mousePosition === undefined) return;
            var x = this.mousePosition.x-(el.width()*.5);
            var y = this.mousePosition.y-el.height()-margin;
            if (y < topOffset) {
                y = this.mousePosition.y+100;
            }
            if (x + el.width() > $("#cesiumContainer").width()) {
                x = $("#cesiumContainer").width() - el.width() - 20;
            }
            if (!visible) {
                x = -10000;
                y = -10000;
            }
            x += leftOffset;
            el.offset({left:x, top:y});
        }

        setBboxWidget (bbox:Array<Cesium.Cartographic>) {
            var rectangle = Cesium.Rectangle.fromCartographicArray(bbox);
            var widget = this.facetWidgets["bbox"];
            var current = widget.getActiveValue();
            // console.log("bbox:", current, rectangle);
            if (current === undefined || current !== "*" || rectangle) {
                // not currently active
                var value = Cesium.Math.toDegrees(rectangle.west).toFixed(4) + "_" + Cesium.Math.toDegrees(rectangle.south).toFixed(4) + "_" + Cesium.Math.toDegrees(rectangle.east).toFixed(4) + "_" + Cesium.Math.toDegrees(rectangle.north).toFixed(4);
                widget.setValue(value, "Selected area");
                widget.selectIndex(1);
            }
        }

        startDrawing () {
            this.isDrawing = true;
            this.scene.screenSpaceCameraController.enableRotate = false;
            this.scene.screenSpaceCameraController.enableTranslate = false;
            this.scene.screenSpaceCameraController.enableTilt = false;
            this.disableFacets();
        }

        stopDrawing() {
            this.isDrawing = false;
            this.scene.screenSpaceCameraController.enableRotate = true;
            this.scene.screenSpaceCameraController.enableTranslate = true;
            this.scene.screenSpaceCameraController.enableTilt = true;
            this.boundsSelectionEntity.show = false;
            this.enableFacets();
        }

        closeFacets() {
            for (var key in this.facetWidgets) {
                var widget = this.facetWidgets[key];
                if (widget === undefined) continue;
                widget.closeGroup();
            }
        }

        addResults (results, start, total) {
            var l = results.length;
            if (start > 0) {
                this.resultsElement.find(".results").append("<p><strong>Results " + (start) + " to " + (start + l) + "</strong></p>");
            }
            for (var i = 0; i < l; i++) {
                this.buildConstituent(results[i]._source);
            }
            this.resultsElement.find(".results").append("<hr />");
            if (start + l < total) {
                var more = total - (l + start) > this.resultLimit ? this.resultLimit : total - (l + start);
                var string = '<div class="link more"><span>Load '+more+' more</span></div>';
                this.resultsElement.find(".more").replaceWith(string);
                this.resultsElement.find(".more").click( () => this.loadMoreResults(start + l) );
            }
        }

        loadMoreResults (start) {
            this.resultsElement.find(".more").empty();
            var filters = "hits.total,hits.hits";//this.buildBaseQueryFilters();
            var data = this.buildFacetQuery();
            // console.log(start, data);
            this.getData({filters:filters, data:data, callback:function(data) {
                var scroll = $("#constituents .scroller").scrollTop();
                var height = $("#constituents .scroller").height();
                var constituents = data.hits.hits;
                this.totalPhotographers = data.hits.total;
                this.addResults(constituents, start, data.hits.total);
                this.scrollResults(scroll + height - 100);
            }, source:"", size:this.resultLimit, exclude:"address", from:start});
        }

        buildConstituent (p) {
            var str = '<div id="constituent-item-' + p.ConstituentID + '" class="constituent-item">';
            str += '<h3 class="constituent-toggle-' + p.ConstituentID + '"><span class="title">' + p.DisplayName;
            str += '</span>';
            str += "<span class=\"subtitle\">";
            str += p.DisplayDate;
            if (p.addressTotal) str += '<br />(' + p.addressTotal + ' location' + (p.addressTotal != 1 ? 's' : '') + ')';
            str += "</span>"
            str += '</h3>';
            str += '<div class="hidden constituent-content constituent-content-' + p.ConstituentID + '">';

            var url = '/export/?ConstituentID=' + p.ConstituentID
            var urlGeo = this.geoJsonPrefix + encodeURIComponent('/export/?type=geojson&ConstituentID=' + p.ConstituentID);

            str += '<p class="constituent-id">';
            str += "<strong>ID:</strong> " + p.ConstituentID;
            str += '<br /><span class="constituent-export">Export data as: <a href="' + url + '" target="_blank" title="opens in new window">JSON</a> | <a href="' + urlGeo + '" target="_blank" title="open dataset in GeoJSON.io">GeoJSON</a></span>';
            str += "</p>";
            str += '<div class="tabs">';
            str += '<div class="metadata-toggle link active"><strong>';
            str += 'Information';
            str += '</strong></div>';
            if (p.addressTotal > 0) {
                str += '<div class="address-toggle link"><strong>';
                if (p.addressTotal != 1) {
                    str += 'Locations ('+p.addressTotal+')';
                } else {
                    str += 'Location';
                }
                str += '</strong></div>';
            }
            str += '</div>';

            str += '<div class="constituent-metadata open constituent-metadata-' + p.ConstituentID + '">';
            // str += '<a href="http://digitalcollections.nypl.org/search/index?utf8=%E2%9C%93&keywords=' + (p.DisplayName.replace(/\s/g, "+")) + '">View photos in Digital Collections</a><br />';
            if (p.TextEntry && p.TextEntry !== "NULL") {
                str += "<p>";
                // str += "<strong>Bio:</strong><br />";
                str += p.TextEntry;
                str += "</p>";
            }
            if (p.gender) str += "<p><strong>Gender:</strong><br />" + p.gender[0].Term + "</p>";
            if (p.role) {
                str += "<p>";
                str += "<strong>Roles:</strong><br />";
                var list = [];
                for (var i in p.role) {
                    list.push(p.role[i].Term);
                }
                str += list.join(", ");
                str += "</p>";
            }
            if (p.process) {
                str += "<p>";
                str += "<strong>Processes used:</strong><br />";
                var list = [];
                for (var i in p.process) {
                    // console.log(p.process[i].TermID);
                    if (this.facetValues["processes"][p.process[i].TermID] !== undefined) list.push(p.process[i].Term);
                }
                str += list.join(", ");
                str += "</p>";
            }
            if (p.format) {
                str += "<p>";
                str += "<strong>Formats used:</strong><br />";
                var list = [];
                for (var i in p.format) {
                    list.push(p.format[i].Term);
                }
                str += list.join(", ");
                str += "</p>";
            }
            if (p.collection) {
                var links = [];
                for (var i in p.collection) {
                    if (p.collection[i].URL == "") {
                        continue;
                    }
                    var link = '<li><a target="_blank" class="external" title="this link opens in a new window" href="'+ p.collection[i].URL +'">';
                    link += p.collection[i].Term;
                    link += '</a></li>';
                    links.push(link);
                }
                if (links.length > 0) {
                    // str += "<p>";
                    str += "<ul class=\"link-list\">";
                    str += "<strong>Included in collections:</strong>";
                    str += links.join("");
                    str += "</ul>";
                    // str += "</p>";
                }
            }
            if (p.biography) {
                // str += "<p>";
                str += "<ul class=\"link-list\">";
                str += "<strong>Data from:</strong>";
                var links = [];
                for (var i in p.biography) {
                    var link = '<li><a target="_blank" class="external" title="this link opens in a new window" href="'+ p.biography[i].URL +'">';
                    link += p.biography[i].Term;
                    link += '</a></li>';
                    links.push(link);
                }
                str += links.join("");
                str += "</ul>";
                // str += "</p>";
            }
            str += "</div>"; // metadata end
            if (p.addressTotal > 0) {
                str += '<div class="addresses"><div id="constituent-addresslist-'+p.ConstituentID+'"></div></div>';
            }
            str += "</div>";
            this.resultsElement.find(".results").append(str);
            $(".constituent-toggle-" + p.ConstituentID).click( () => {
                $(".constituent-content-" + p.ConstituentID).fadeToggle(200);
                $("#constituent-item-" + p.ConstituentID).toggleClass("open");
                $(".constituent-toggle-" + p.ConstituentID).toggleClass("open");
                // window.open("/constituents/" + p.ConstituentID);
            });
            $("#constituent-item-" + p.ConstituentID + " .metadata-toggle").click( () => {
                $("#constituent-item-" + p.ConstituentID + " .metadata-toggle").addClass("active");
                $("#constituent-item-" + p.ConstituentID + " .address-toggle").removeClass("active");
                $(".constituent-metadata-" + p.ConstituentID).addClass("open");
                $("#constituent-addresslist-" + p.ConstituentID + " .constituent-addresslist").removeClass("open");
            } );
            $("#constituent-item-" + p.ConstituentID + " .address-toggle").click( () => {
                if (!$("#constituent-addresslist-" + p.ConstituentID).hasClass("loaded")) {
                    $("#constituent-addresslist-" + p.ConstituentID).addClass("loaded");
                    $("#constituent-addresslist-" + p.ConstituentID).append('<div class="address-spinner"></div>');
                    var spinner = $("#constituent-addresslist-" + p.ConstituentID + " .address-spinner");
                    var opts = {
                        lines: 10, // The number of lines to draw
                        width: 6, // The line thickness
                        radius: 20, // The radius of the inner circle
                        color: "#000"
                    };
                    this.showSpinner(spinner, opts);
                    this.getAddressList(parseInt(p.ConstituentID));
                }
                $("#constituent-item-" + p.ConstituentID + " .metadata-toggle").removeClass("active");
                $("#constituent-item-" + p.ConstituentID + " .address-toggle").addClass("active");
                $(".constituent-metadata-" + p.ConstituentID).removeClass("open");
                $("#constituent-addresslist-" + p.ConstituentID + " .constituent-addresslist").addClass("open");
            });
        }

        getAddressList (id) {
            // console.log(id);
            // change url without commiting new state change
            var filters = "hits.total,hits.hits";
            var data = this.buildElasticQuery(["ConstituentID:" + id,"address.ConstituentID:" + id], ["*"], "parent");
            this.getData({filters:filters, data:data, callback:this.parseConstituentAddresses, source:"", docType:"address", size:this.elasticSize, exclude:"", sort:"", from:0, parameter:id});
        }

        parseConstituentAddresses (data, id) {
            $("#constituent-addresslist-" + id + " .address-spinner").remove();
            // console.log(data)
            this.buildConstituentAddresses(id, data.hits.hits);
            this.connectAddresses(id);
        }

        buildConstituentAddresses (id, addresses) {
            // console.log(id);
            if (addresses) {
                addresses = this.sortAddresses(addresses)
                var addstring = "";
                for (var i=0; i < addresses.length; i++) {
                    var add = addresses[i];
                    // console.log(add)
                    addstring += "<div class=\"address-item\">";
                    // addstring += "ID:" + add.ConAddressID + "<br />";
                    addstring += "<div class=\"address-item-type\">";
                    addstring += "<strong>" + add.AddressType + "</strong>";
                    if (add.DisplayName2 != "NULL") addstring += " (" + add.DisplayName2 + ")";
                    addstring += "</div>";
                    if (add.Remarks != "NULL" && add.Remarks != "0,0") {
                        addstring += ' <div class="link constituent-address" id="constituent-address-' + add.ConAddressID + '" data-id="' + add.ConAddressID + '">Go</div>';
                    }
                    addstring += "<div class=\"address-item-content\">";
                    if (add.StreetLine1 != "NULL") addstring += add.StreetLine1 + "<br />";
                    if (add.StreetLine2 != "NULL") addstring += add.StreetLine2 + "<br />";
                    if (add.StreetLine3 != "NULL") addstring += add.StreetLine3 + "<br />";
                    if (add.City != "NULL") addstring += add.City + ", ";
                    if (add.State != "NULL") addstring += add.State + "<br />";
                    if (add.CountryID != "NULL") addstring += add.Country + "<br />";
                    // addstring += add.Remarks + "<br />";
                    addstring += "</div>";
                    addstring += "</div>";
                }
                var str = '<div class="constituent-addresslist open">';
                if (addresses.length != 1) {
                    str += '<span class="link connector">';
                    str += 'SHOW LINES';
                    str += "</span>";
                }
                // str += "<p>";
                // str += "<strong>Addresses:</strong>";
                // str += "</p>";
                str += addstring;
                str += '</div>';
                $("#constituent-addresslist-" + id).append(str);
                $("#constituent-addresslist-" + id + " .connector").click( () => this.connectAddresses(id) );
                $("#constituent-addresslist-" + id + " .link.constituent-address").click( (e) => {
                        var id = $(e.target).data("id");
                        if (this.hasWebGL) this.flyToAddressID(id);
                });
            }
        }

        sortAddresses (addresses:Array<any>) {
            // console.log(addresses)
            var sortedAddresses = []
            var born
            var died
            if (addresses.length == 1) {
                return [addresses[0]._source]
            }
            // sort by date
            addresses = addresses.sort(function (a, b) {
                if (a['BeginDate'] > b['BeginDate']) return 1
                if (a['BeginDate'] < b['BeginDate']) return -1
                return 0
            })

            for (var key in addresses) {
                var add = addresses[key]._source
                // put the active/biz ones
                if (add['AddressTypeID'] == '7' || add['AddressTypeID'] == '2') {
                    sortedAddresses.push(add)
                }
                // find born if any
                if (add['AddressTypeID'] == '5') {
                    born = add
                }
                // find died if any
                if (add['AddressTypeID'] == '6') {
                    died = add
                }
            }
            // prepend born
            if (born) sortedAddresses.unshift(born)
            // append died
            if (died) sortedAddresses.push(died)
            return sortedAddresses
        }

        flyToAddressID (id) {
            var index = this.pointHash[id];
            var p = this.pointArray[index];
            var height = p[6] ? p[6] + (this.heightDelta * 50) : (this.heightDelta * 50);
            // console.log(id, height, p);
            this.viewer.camera.flyTo({
                destination : Cesium.Cartesian3.fromDegrees(p[1], p[0], height),
                duration : 1.5
            });
        }

        connectAddresses (id) {
            // console.log(id);
            if (!this.hasWebGL) return
            location.hash = id;
            this.resetBounds();
            this.removeLines();
            var connector = $("#constituent-addresslist-" + id + " .connector");
            if (connector.length !== 0 && connector.hasClass("connected")) {
                // thing is somewhere on the page and is activated
                // probably user wants to hide lines
                connector.removeClass("connected");
                connector.text("SHOW LINES");
                this.updateLineText()
                return;
            } else {
                $(".link.connector").removeClass("connected");
                $(".link.connector").text("SHOW LINES");
                connector.addClass("connected");
                connector.text("HIDE LINES");
            }
            var addresses = this.addressesForID(id);
            var lastPoint = addresses[0];
            var positions = [];
            var colors = [];
            var usefulAddresses = 0
            for (var i=0; i < addresses.length; i++) {
                var p = addresses[i];
                // console.log(p, addresses[i]);
                if (p === undefined) continue;
                if (p[0] === 0 && p[1] === 0) continue;
                this.expandBounds(p);
                var height = p[6] !== undefined ? p[6] : this.heightHash[p[3]];
                positions.push(p[1], p[0], height);
                colors.push(this.addressTypePalette[p[4]]);
                usefulAddresses ++
            }

            if (usefulAddresses > 1) {
                this.lines = new Cesium.Primitive({
                  geometryInstances : new Cesium.GeometryInstance({
                    geometry : new Cesium.PolylineGeometry({
                      positions : Cesium.Cartesian3.fromDegreesArrayHeights(positions),
                      width : this.lineWidth,
                      vertexFormat : Cesium.PolylineColorAppearance.VERTEX_FORMAT,
                      colors: colors,
                      colorsPerVertex: true
                    })
                  }),
                  appearance : new Cesium.PolylineColorAppearance({
                    translucent : false
                  })
                });
                this.scene.primitives.add(this.lines);
                this.updateLineText(id)
            }
            

            this.updateBounds();
        }
        
        updateLineText (id = undefined) {
            $("#total-points .linetext").remove()
            if (id === undefined) return
            var filters = "hits.total,hits.hits";
            var data = this.buildElasticQuery(["ConstituentID:" + id], ["*"], "child")
            this.getData({filters:filters, data:data, callback:function (data) {
                // console.log(data)
                if (!data.hits.hits || data.hits.hits.length < 1) return
                var html = '<div class="linetext">'
                html += 'Showing lines for '
                html += data.hits.hits[0]._source.DisplayName
                html += '</div>'
                $("#total-points").append(html)
            }, source:"DisplayName", docType:"constituent", size:1, exclude:"", sort:"", from:0})
        }

        dimPoints () {
            // TODO: dim points function
        }

        getFacets () {
            for (var i=0; i < this.facets.length; i++) {
                if (this.facets[i][1] != "") {
                    if (this.facets[i][3] === "AddressType") $("#facet-list").append("<h4>Locations</h4>")
                    if (this.facets[i][3] === "Nationality") $("#facet-list").append("<h4>Constituents</h4>")
                    if (this.facets[i][0] === "bbox" && !this.hasWebGL) continue
                    this.getFacet(i)
                }
            }
        }

        getFacet (index) {
            var facet = this.facets[index];

            var widget = this.createFacet(facet);


            if (facet[0] !== "bbox") {
                // hack for ignoring the bbox (has no csv)
                // var url = this.rootPath + "csv/" + facet[0] + ".csv?i=" + Math.round(Math.random() * 100000000);
                var url = this.rootPath + "csv/" + facet[0] + ".csv";
                this.loadTextFile(url, this.updateFacet, facet);
            } else {
                this.initFacetWidget(widget);
            }
        }

        createFacet (facet):Facet {
            var f = facet[0];
            this.facetValues[f] = {};
            this.facetWidgets[f] = new Facet(f, $("#facet-list"), facet[1]);
            this.updateFilter(f, "*");
            return this.facetWidgets[f];
        }

        updateFacet (responseText, facet) {
            var data = responseText.csvToArray({trim:true, rSep: '\n'});
            var widget = this.facetWidgets[facet[0]];
            var idColumn = data[0].indexOf(facet[2]);
            var nameColumn = data[0].indexOf(facet[3]);
            var name;
            var value;
            var l = data.length;
            for (var i = 1; i < l; i++) {
                value = data[i][idColumn];
                name = data[i][nameColumn];
                this.facetValues[facet[0]][value] = name;
                widget.addFacetItem(name, value);
            }
            this.initFacetWidget(widget);
        }

        initFacetWidget (facet:Facet) {
            facet.init();
            facet.element.on("facet:change", (e, widget: Facet) => { this.onFacetChanged(widget) });
        }

        facetWithName (name): Array<string> | Number {
            for (var i=0; i < this.facets.length; i++) {
                if (this.facets[i][0]==name) return this.facets[i];
            }
            return -1;
        }

        facetWithKeyPair(key1, key2): Array<string> | Number {
            for (var i = 0; i < this.facets.length; i++) {
                if (this.facets[i][2] == key2 && this.facets[i][4] == key1) return this.facets[i];
            }
            return -1;
        }

        disableFacets() {
            for (var widget in this.facetWidgets) {
                this.facetWidgets[widget].disable();
            }
            this.clearResults();
        }

        enableFacets () {
            for (var widget in this.facetWidgets) {
                this.facetWidgets[widget].enable();
            }
        }

        buildFacetList () {
            var facetList = [];
            for (var k in this.filters) {
                if (this.filters[k] != "*") {
                    if (k === "Date") {
                        // facetList.push("(BeginDate:" + this.filters[k] + " OR EndDate:" + this.filters[k] + ")");
                        facetList.push("(address.BeginDate:" + this.filters[k] + " OR address.EndDate:" + this.filters[k] + ")");
                        // facetList.push("(BeginDate:" + this.filters[k] + " OR EndDate:" + this.filters[k] + ")");
                    } else if (k === "bbox") {
                        var bbox = this.filters[k];
                        facetList.push("bbox:" + bbox);
                    } else {
                        facetList.push("(" + k + ":" + this.filters[k] + ")");
                    }
                }
            }
            return facetList;
        }

        buildFacetQuery (facetList=undefined, type:string="child") {
            if (facetList === undefined) facetList = this.buildFacetList();
            var normal = [];
            var filter = [];
            for (var k in facetList) {
                if (facetList[k].indexOf("bbox") === -1) {
                    if (facetList[k].indexOf("DisplayName") !== -1) {
                        // deconstruct facet to convert to ID
                        var cleaned = facetList[k].replace(/([\(\)\:\.]*)/g, '');
                        cleaned = cleaned.replace('DisplayName', '');
                        var isNumeric = !isNaN(Number(cleaned));
                        if (!isNumeric) {
                            // removing period to allow for searches like "john d. rock"
                            normal.push(facetList[k].replace(/([\.]*)/g, ''));
                        } else {
                            normal.push("(ConstituentID:"+cleaned+")");
                        }
                    } else if (facetList[k].indexOf("Place") !== -1) {
                        // deconstruct facet to convert to ID
                        // normal.push(facetList[k]);
                    } else {
                        normal.push(facetList[k]);
                    }
                } else {
                    filter.push(facetList[k]);
                }
            }

            var facetQuery = this.buildElasticQuery(normal, filter, type);
            return facetQuery;
        }

        // buildBaseQueryFilters() {
        //     return "hits.total,hits.hits";
        // }

        clearResults() {
            this.resultsElement.find(".results").empty();
            this.resultsElement.find(".more").empty();
            this.removeLines();
            this.hideSpinner(this.resultsElement);
        }

        updateFilter (facetName, value) {
            var facet = this.facetWithName(facetName);
            if (facet[4] !== "") {
                this.filters[facet[4]+"."+facet[2]] = value;
            } else if (facet[2] === "DisplayName") {
                this.filters[facet[2]] = value;
            } else if (facet[2] === "bbox") {
                if (value == "Select area on map") {
                    this.filters[facet[2]] = value;
                } else {
                    this.filters[facet[2]] = value;
                }
            } else {
                this.filters[facet[2]] = value;
            }
        }

        applyFilters () {
            var url = this.buildQueryString();
            Historyjs.pushState(this.filters, "PIC - Photographers’ Identities Catalog", url);
        }

        buildQueryString ():string {
            var url = "?";
            var keyVals = [];
            for (var filter in this.filters) {
                keyVals.push(filter + "=" + this.filters[filter]);
            }
            url += keyVals.join("&");
            var mode = 3
            if (this.hasWebGL) mode = this.scene.mode
            url += "&mode=" + mode
            return url;
        }

        scrollResults (value = 0) {
            $("#constituents .scroller").animate({scrollTop:value}, 500, 'swing');
        }

        changeState () {
            this.pickedEntity = undefined;
            this.closeFacets();
            this.disableFacets();
            if (this.hasWebGL) this.removePoints();
            this.showSpinner(this.resultsElement);
            if (this.buildFacetList().length == 0) {
                $("#facets-clear").addClass("disabled");
            } else {
                $("#facets-clear").removeClass("disabled");
            }
            var addresses = [];
            var data = this.buildFacetQuery(undefined, "parent");
            var filters = "hits.total,hits.hits,aggregations";
            this.start = new Date().getTime();
            // console.log("apply", data);
            // clear
            this.totalPhotographers = 0;
            this.elasticResults = {
                data: data,
                from: 0,
                hits: [],
                total: 0,
                filters: filters,
            };
            // end clear
            var facetList = this.buildFacetList();
            if (facetList.length === 0) {
                this.displayBaseData();
            } else {
                this.getData({filters:filters, data:data, callback:this.getNextSet, docType: "address", sort: "", source:"ConAddressID"});
            }
            this.updateTotals(-1);
        }

        clearFilters () {
            this.resetNameQuery();
            this.resetDateQuery();
            for (var i = 0; i < this.facets.length; i++) {
                var facet = this.facets[i];
                var f = facet[0];
                this.updateFilter(f, this.defaultValue);
                var widget = this.facetWidgets[f];
                if (widget === undefined) continue;
                widget.reset();
                this.initFacetWidget(widget);
                widget.init(); // hack... but works ¯\_(ツ)_/¯
            }
            if (this.hasWebGL) this.stopDrawing();
            this.applyFilters();
        }

        getNextSet (results) {
            // console.log(results);
            // elasticResults.hits = elasticResults.hits.concat(results.hits.hits
            this.totalPhotographers = 0//results.hits.total;
            if (results.aggregations) {
                this.applyAggregations(results.aggregations)
            }
            if (results.hits.total > this.elasticResults.from + this.elasticSize) {
                // keep going
                var data = this.elasticResults.data;
                this.elasticResults.from += this.elasticSize;
                var filters = this.elasticResults.filters;
                this.getData({filters:filters, data:data, callback:this.getNextSet, docType: "address", sort: "", source:"ConAddressID", size:this.elasticSize, exclude:"", from:this.elasticResults.from});
            } else {
                var end = new Date().getTime();
                var time = end - this.start;
                console.log("took:", time, "ms");
                this.enableFacets();
                this.showResults();
            }
            if (results.hits.hits) this.addressesToPoints(results.hits.hits);
            if (results.hits.total <= this.elasticResults.from + this.elasticSize) {
                this.updateBounds();
            }
            this.updateTotals(-1);
        }

        showResults () {
            var data = this.buildFacetQuery();
            var filters = "hits.total,hits.hits,aggregations";//this.buildBaseQueryFilters();
            // console.log("results", data);
        }

        showSpinner (target, opts = {}) {
            var defaults = {
                lines: 20, // The number of lines to draw
                length: 0, // The length of each line
                width: 12, // The line thickness
                radius: 60, // The radius of the inner circle
                corners: 1, // Corner roundness (0..1)
                rotate: 0, // The rotation offset
                color: '#fff', // #rgb or #rrggbb
                speed: 1, // Rounds per second
                trail: 60, // Afterglow percentage
                shadow: false, // Whether to render a shadow
                hwaccel: false, // Whether to use hardware acceleration
                className: 'spinner', // The CSS class to assign to the spinner
                // zIndex: 9, // The z- index(defaults to 2000000000)
                // top: '100px', // Top position relative to parent in px
                // left: '50%' // Left position relative to parent in px
            }

            $.extend(defaults, opts);

            var spin = new Spinner(defaults).spin();
            target.append(spin.el);
        }

        hideSpinner (target) {
            target.find(".spinner").remove();
        }

        addressesForID (id) {
            var i;
            var addresses = [];
            for (i in this.pointArray) {
                if (this.pointArray[i][2] === id) addresses.push(this.pointArray[i]);
            }
            return addresses;
        }

        addressesToPoints (hits) {
            var addresses = [];
            // var hits = elasticResults.hits;
            // console.log(elasticResults);
            var i, j, l = hits.length;
            for (i=0; i < l; ++i) {
                var item = hits[i]._source;
                if (item.ConAddressID === undefined) continue;
                // for (j=0; j < item.address.length; ++j) {
                    addresses.push(item.ConAddressID);
                // }
            }
            this.addPoints(addresses);
        }

        addPoints (newPoints) {
            // console.log("addpoints",newPoints)
            if (!this.hasWebGL) return
            if (newPoints.length === 0) return;
            var bounds = "*";
            var n = 180;
            var s = -180;
            var e = 180;
            var w = -180;
            if (bounds != "*") {
                var boundsArray = bounds.split("_");
                if (boundsArray.length === 4) {
                    w = Number(boundsArray[0]);
                    s = Number(boundsArray[1]);
                    e = Number(boundsArray[2]);
                    n = Number(boundsArray[3]);
                }
            }
            var i, l = newPoints.length;
            for (i = 0; i < l; i++) {
                var index = this.pointHash[newPoints[i]];
                var p = this.pointArray[index];
                if (!p) continue;
                var height;
                // point has no real height
                if (p[6] === undefined) {
                    var latlonHash = p[0]+","+p[1];
                    if (this.latlonHeightHash[latlonHash] === undefined) {
                        height = this.heightDelta;
                    } else {
                        height = this.latlonHeightHash[latlonHash] + this.heightDelta;
                    }
                    this.latlonHeightHash[latlonHash] = height;
                    this.heightHash[p[3]] = height;
                } else {
                    height = p[6];
                }
                this.elasticResults.total++;
                this.expandBounds(p);
                var pt = this.points.add({
                    id: "P_"+p[2],
                    position : Cesium.Cartesian3.fromDegrees(p[1], p[0], height),
                    color: this.addressTypePalette[p[4]],//new Cesium.Color(1, 0.01, 0.01, 1),
                    pixelSize : this.pixelSize,
                    scaleByDistance : new Cesium.NearFarScalar(1.0e1, this.farScale, 1.0e10, this.nearScale)
                });
                pt.originalLatlon = p[0] + "," + p[1] + (p[6] ? "," + p[6] : "");
            }
            this.updateTotals(-1);
        }

        expandBounds (p) {
            if (p[1] > this.bounds[0]) this.bounds[0] = p[1] + this.padding;
            if (p[0] > this.bounds[1]) this.bounds[1] = p[0] + this.padding;
            if (p[1] < this.bounds[2]) this.bounds[2] = p[1] - this.padding;
            if (p[0] < this.bounds[3]) this.bounds[3] = p[0] - this.padding;
        }

        removePoints () {
            this.resetBounds();
            this.points.removeAll();
            this.removeLines();
            this.latlonHeightHash = {};
            this.heightHash = {};
        }

        removeLines () {
            if (this.hasWebGL) this.scene.primitives.remove(this.lines);
        }

        resetDateQuery () {
            var from = $("#" + this.fromDateElement);
            var to = $("#" + this.toDateElement);
            from.val(this.minYear.toString());
            to.val(this.maxYear.toString());
            this.updateFilter("date", "*");
        }

        resetNameQuery () {
            var el = $("#" + this.nameQueryElement)
            el.val("");
            this.updateFilter(this.nameQueryElement, "*");
        }

        validateYear (element, defaultValue) {
            var el = $("#" + element);
            var str = el.val().trim();
            if (str === "") {
                el.val(defaultValue);
                return defaultValue;
            }
            var year = parseInt(str);
            if (isNaN(year)) {
                el.val(defaultValue);
                return defaultValue;
            }
            return year;
        }

        updateTimeFilters () {
            var from = this.validateYear(this.fromDateElement, this.minYear);
            var to = this.validateYear(this.toDateElement, this.maxYear);
            var value = "*";
            if ((from !== this.minYear || to !== this.maxYear) && from < to) {
                value = '[' + from + ' TO ' + to + ']';
            }
            this.updateFilter("date", value);
        }

        humanizeFilters () {
            /*
            template:
            0  Birth
               places
            1  in Australia
            11 within bounds
               for
            2  English
            3  , Female
               photographers
            9  named george
            4  who created daguerreotype
            5  who worked as clerk
            6  producing cabinet cards
            8  whose work is collected by NYPL
            10 who were alive or active from 1890 to 1895
            7  whose data came in part from Eastman House
            */
            var subject = "";
            var predicate = "";
            var text = "";
            var facet;
            var facetKey;
            var key;
            var hasQualifier = false;

            // addresstype
            facet = this.facets[0];
            facetKey = facet[4] + "." + facet[2];
            key = this.filters[facetKey];
            if (key !== "*") {
                subject += "<em>" + this.facetValues[facet[0]][key] + "</em> ";
            }

            subject += this.elasticResults.total != 1 ? " locations " : " location ";

            // country
            facet = this.facets[1];
            facetKey = facet[4] + "." + facet[2];
            key = this.filters[facetKey];
            if (key !== "*") {
                subject += "in <em>" + this.facetValues[facet[0]][key] + "</em> ";
            }

            // bbox
            facet = this.facets[2];
            facetKey = facet[2];
            key = this.filters[facetKey];
            if (key !== "*") {
                subject += " <em>within the selected area</em> ";
            }

            predicate = "for "

            if (this.totalPhotographers > 0) predicate += this.totalPhotographers.toLocaleString()

            // nationality
            facet = this.facets[3];
            facetKey = facet[2];
            key = this.filters[facetKey];
            if (key !== "*") {
                predicate += " <em>" + this.facetValues[facet[0]][key] + "</em>";
            }

            // gender
            facet = this.facets[4];
            facetKey = facet[4] + "." + facet[2];
            key = this.filters[facetKey];
            if (key !== "*") {
                predicate += (predicate !== "for " + this.totalPhotographers + " " ? ", " : "") + "<em>" + this.facetValues[facet[0]][key] + "</em> ";
            }

            predicate += this.totalPhotographers != 1 ? " constituents " : " constituent ";

            // name
            facet = this.facets[10];
            facetKey = facet[2];
            key = this.filters[facetKey];
            if (key !== "*") {
                var name = $("#" + this.nameQueryElement).val();
                var isNumeric = !isNaN(Number(name));
                if (!isNumeric) {
                    predicate += "named <em>" + name + "</em> ";
                } else {
                    predicate += "with ID <em>" + name + "</em> ";
                }
            }

            // process
            facet = this.facets[5];
            facetKey = facet[4] + "." + facet[2];
            key = this.filters[facetKey];
            if (key !== "*") {
                predicate += "who created <em>" + this.facetValues[facet[0]][key] + "</em> ";
            }

            // role
            facet = this.facets[6];
            facetKey = facet[4] + "." + facet[2];
            key = this.filters[facetKey];
            if (key !== "*") {
                predicate += "who worked as <em>" + this.facetValues[facet[0]][key] + "</em> ";
            }

            // format
            facet = this.facets[7];
            facetKey = facet[4] + "." + facet[2];
            key = this.filters[facetKey];
            if (key !== "*") {
                predicate += "producing <em>" + this.facetValues[facet[0]][key] + "</em> ";
            }

            // collections
            facet = this.facets[9];
            facetKey = facet[4] + "." + facet[2];
            key = this.filters[facetKey];
            if (key !== "*") {
                predicate += "whose work is collected by <em>" + this.facetValues[facet[0]][key] + "</em> ";
            }

            // dates
            facet = this.facets[11];
            facetKey = "Date";
            key = this.filters[facetKey];
            if (key !== "*") {
                var dates = $("#" + this.fromDateElement).val();
                dates += " to " + $("#" + this.toDateElement).val();
                predicate += "between the years <em>" + dates + "</em> ";
            }

            // biography
            facet = this.facets[8];
            facetKey = facet[4] + "." + facet[2];
            key = this.filters[facetKey];
            if (key !== "*") {
                predicate += "whose data came in part from <em>" + this.facetValues[facet[0]][key] + "</em> ";
            }

            text = subject + predicate;

            return text;
        }

        updateNameFilter () {
            var str = $("#" + this.nameQueryElement).val().trim();
            if (str !== "") {
                var isNumeric = !isNaN(Number(str));
                if (!isNumeric) {
                    str = str.replace(/([\+\-=&\|><!\(\)\{\}\[\]\^"~\*\?:\\\/])/g, ' ');
                    str = str.trim().replace(/\s/g, " ");
                    str = str + "~4";
                    var f = str.split(" ");
                    var legit = [];
                    for (var thing in f) {
                        var trimmed = f[thing].trim();
                        if (trimmed !== "") legit.push(trimmed);
                    }
                    str = '(' + legit.join("~4 AND ") + ')';
                }
            } else {
                str = "*";
            }
            var value = str;
            this.updateFilter(this.nameQueryElement, value);
        }

        onFromDateKeyUp(e) {
            var el = e.target;
            if (e.keyCode === 13) {
                this.updateTimeFilters();
                this.applyFilters();
            }
        }

        onToDateKeyUp (e) {
            var el = e.target;
            if (e.keyCode === 13) {
                this.updateTimeFilters();
                this.applyFilters();
            }
        }

        onNameQueryKeyUp(e) {
            var el = e.target;
            if (e.keyCode === 13) {
                this.updateNameFilter();
                this.applyFilters();
            }
        }

        onFacetChanged(widget: Facet) {
            if (widget === this.facetWidgets["bbox"]) {
                // console.log("ch-ch-ch-changes!", widget.value);
                if (widget.value !== "*") {
                    // nothing happens until drawing ends
                    this.startDrawing();
                    return;
                }
            }
            this.updateFilter(widget.ID, widget.value);
            this.applyFilters();
        }

        onCameraMoved (event:Cesium.Event) {
            // console.log("moved",this.camera.position);
        }

        changeViewTo (mode) {
            if (!this.hasWebGL) return
            if (mode !== Number(this.scene.mode)) {
                switch (mode) {
                    case 1:
                        this.scene.morphToColumbusView();
                        break
                    case 2:
                        this.scene.morphTo2D();
                        break
                    case 3:
                        this.scene.morphTo3D();
                        break
                }
            }
        }

        initListeners () {
            // this.resetNameQuery();
            // this.resetDateQuery();
            // var from = $("#" + this.fromDateElement);
            // var to = $("#" + this.toDateElement);
            // from.keyup((e) => this.onFromDateKeyUp(e));
            // from.blur(() => this.updateTimeFilters());
            // to.keyup((e) => this.onToDateKeyUp(e));
            // to.blur(() => this.updateTimeFilters());
            // var name = $("#" + this.nameQueryElement)
            // name.keyup((e) => this.onNameQueryKeyUp(e));
            // name.blur(() => this.updateNameFilter());
            // $("#facets-clear").click(() => this.clearFilters());
            if (!this.hasWebGL) return
            this.scene.morphComplete.addEventListener( () => {
                if (this.scene.mode !== 2) {
                    this.hideMoon();
                } else {
                    this.showMoon();
                }
                var url = this.buildQueryString();
                Historyjs.pushState({ignore:true,mode:this.scene.mode}, "PIC - Photographers’ Identities Catalog", url);
                // this.updateTextLabels();
                // this.viewer.sceneModePicker.viewModel.dropDownVisible = true;
            });
            this.camera.moveEnd.addEventListener( () => {
                this.storedView.save(this.camera);
                // this.viewer.sceneModePicker.viewModel.dropDownVisible = true;
                // console.log(JSON.stringify(this.storedView));
            })
            this.viewer.geocoder.viewModel.search.afterExecute.addEventListener(() => {this.notifyRepaintRequired()});
            // this.camera.moveEnd.addEventListener(() => this.onCameraMoved());
        }

        notifyRepaintRequired () {
            // console.log("repaint");
            if (!this.hasWebGL) return
            if (this.verboseRendering && !this.viewer.useDefaultRenderLoop) {
                // console.log('starting rendering @ ' + Cesium.getTimestamp());
            }
            this.lastCameraMoveTime = Cesium.getTimestamp();
            // this.viewer.sceneModePicker.viewModel.dropDownVisible = true;
            this.viewer.useDefaultRenderLoop = true;
        }

        postRender () {
            // We can safely stop rendering when:
            //  - the camera position hasn't changed in over a second,
            //  - there are no tiles waiting to load, and
            //  - the clock is not animating
            //  - there are no tweens in progress
            if (!this.hasWebGL) return
            var now = Cesium.getTimestamp();

            var scene = this.scene;

            if (!Cesium.Matrix4.equalsEpsilon(this.lastCameraViewMatrix, scene.camera.viewMatrix, 1e-5)) {
                this.lastCameraMoveTime = now;
            }

            var cameraMovedInLastSecond = now - this.lastCameraMoveTime < 1000;

            var surface = scene.globe._surface;
            var tilesWaiting = !surface._tileProvider.ready || surface._tileLoadQueue.length > 0 || surface._debug.tilesWaitingForChildren > 0;

            // console.log("postrender", cameraMovedInLastSecond, tilesWaiting, this.viewer.clock.shouldAnimate, this.scene.tweens.length === 0);
            if (!cameraMovedInLastSecond && !tilesWaiting && this.scene.tweens.length === 0) {
                if (this.verboseRendering) {
                    // console.log('stopping rendering @ ' + Cesium.getTimestamp());
                }
                this.viewer.useDefaultRenderLoop = false;
                this.stoppedRendering = true;
            }

            Cesium.Matrix4.clone(scene.camera.viewMatrix, this.lastCameraViewMatrix);
        }
    }
}
