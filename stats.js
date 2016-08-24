var fs = require('fs');
var debug = require('debug')('docker-stats');
var Docker = require('dockerode');
var Stats = require('influx-collector');
var EventEmitter = require('events').EventEmitter;
var difference = require('lodash.difference');

var INFLUXDB_URL = process.env.INFLUXDB_URL;
var SERIES_NAME = process.env.INFLUXDB_SERIES_NAME || 'container-stats';

// if set, determine which label to use for the container name
// otherwise first item in Names will be used
var CONTAINER_NAME_LABEL = process.env.CONTAINER_NAME_LABEL;

var stats = Stats('docker4',INFLUXDB_URL);

stats.on('error', function(err) {
    console.error(err.stack);
});

var docker = new Docker();

// container id -> stats collector
var monitoring_containers = Object.create(null);

(function load_containers() {
    docker.listContainers(function (err, containers) {
        if (err) {
            return console.error(err.stack);
        }

        var current_ids = containers.map(function(container) {
            return container.Id;
        });

        // see which ids are no longer relevant
        // stop collecting those
        var existing = Object.keys(monitoring_containers);

        var removed = difference(existing, current_ids);
        removed.forEach(function(id) {
            debug('removing container %s', id);
            var monitor = monitoring_containers[id];
            monitor.stop();
            delete monitoring_containers[id];
        });

        containers.forEach(function(container) {
            var id = container.Id;
            if (id in monitoring_containers) {
                return;
            }
            //debug('monitoring container %s', id);
            var monitor = monitoring_containers[id] = Monitor(id, container);
            monitor.on('error', function(err) {
                // container not found, remove it
                if (err.statusCode === 404) {
                    debug('removing container %s', id);
                    var monitor = monitoring_containers[id];
                    monitor.stop();
                    delete monitoring_containers[id];
                }
            });
        });

        // container.Labels {}
        // container.Names []
        // has labels via container.Labels
        setTimeout(load_containers, 5000);
    });
})();

function Monitor(container_id, container_info) {
    if (!(this instanceof Monitor)) {
        return new Monitor(container_id, container_info);
    }

    var self = this;
    self._active = false;
    self._container = docker.getContainer(container_id);
    self._id = container_id;

    // datapoint name for the container
    self._name = (container_info.Labels || {})[CONTAINER_NAME_LABEL];
    if (!self._name && container_info.Names.length > 0) {
        self._name = container_info.Names[0];
    }
    self._name = self._name || 'unknown';
    debug('test container %s', self._name);

    self.start();
}

Monitor.prototype.__proto__ = EventEmitter.prototype;

Monitor.prototype.start = function() {
    var self = this;

    if (self._active) {
        return;
    }
    self._active = true;

    (function get_new_stats() {
        if (!self._active) {
            return;
        }

        self._stats(function(err, stat) {
            if (err) {
                self.emit('error', err);
                return;
            }
            //debug('new stats %s %j', self._container.id, stat);
            self._collect(stat);
            setTimeout(get_new_stats, 2000);
        });
    })();
};

Monitor.prototype.stop = function() {
    var self = this;
    self._active = false;
    self.removeAllListeners();
};

Monitor.prototype._stats = function(cb) {
    var self = this;
    self._container.stats(function(err, stats) {
        if (err) {
            return cb(err);
        }

        stats.on('data', function(chunk) {
            var stat = JSON.parse(chunk.toString());
            stats.destroy();
            cb(null, stat);
        });
    });
};

Monitor.prototype._collect = function(stat) {
    var self = this;

    var cpu_percent = 0;
    var prev = self._prev;

    //https://github.com/docker/docker/blob/master/api/client/stats.go#L185
    if (prev) {
        var prev_cpu = prev.cpu_stats.cpu_usage.total_usage;
        var curr_cpu = stat.cpu_stats.cpu_usage.total_usage;
        var cpu_delta = curr_cpu - prev_cpu;
        var sys_delta = stat.cpu_stats.system_cpu_usage - prev.cpu_stats.system_cpu_usage;

        if (sys_delta > 0 && cpu_delta >= 0) {
            cpu_percent = (cpu_delta / sys_delta) * stat.cpu_stats.cpu_usage.percpu_usage.length * 100;
        }
    }

    var networks = stat.networks.eth0;
    var cpu = stat.cpu_stats;
    var memory = stat.memory_stats;

    self._prev = stat;
console.log(networks);
    stats.collect({
        //name: self._name,
        //id: self._id,
/*
        // network
        'networks.rx_bytes': networks.rx_bytes,
        'networks.rx_packets': networks.rx_packets,
        'networks.rx_errors': networks.rx_errors,
        'networks.rx_dropped': networks.rx_dropped,
        'networks.tx_bytes': networks.tx_bytes,
        'networks.tx_packets': networks.tx_packets,
        'networks.tx_errors': networks.tx_errors,
        'networks.tx_dropped': networks.tx_dropped,
*/
        'net_input': networks ? networks.rx_bytes : 0,
        'net_output': networks ? networks.tx_bytes: 0,
        // cpu
        'cpu_usage': cpu_percent,

        // memory
        'memory_usage': memory.usage
        //'memory.max_usage': memory.max_usage,
        //'memory.limit': memory.limit,
        //'memory.failcnt': memory.failcnt,
    },{
        cid: self._id,
        cname: self._name
    });
};
