const fetch = require("node-fetch");
var _ = require('underscore');
var Datastore = require('nedb')
var f = require('./helpFunctions.js');

var DEBUG = false;

// INJECT DATA IN DATABASE
var db = new Datastore();
var json = require('../data/gates.json');
db.insert(json, function(err, result){
     if(!err){
        if (DEBUG) console.log("succesfully imported!")
         db.update({}, {$set:{"occupied":false, "assigned_to": "none"}},{multi:true})
     }
});

let pilots_of_interest = null;
let controllers_of_interest = null;

let monitored_clients = {}
let last_updated = Date.now()

const airports_of_interest = ["EBBR", "ELLX"]
const location_coordinates = {
    "EBBR" : {"latitude": 50.902, "longitude": 4.485},
    "EBCI" : {"latitude": 50.4647, "longitude": 4.4611},
    "ELLX" : {"latitude": 49.6313, "longitude": 6.2157}
}

async function get_all_gates(){
    var gate_list = await new Promise((resolve, reject) => {
        db.find({}, {"_id": 0, "__v":0}).sort({occupied : -1, apron:1 }).exec((err, result) => {
            if (err) reject(err);
            resolve(result);
        });
    });
    return gate_list
}

async function get_all_gates_for_airport(airport){
    var gate_list = await new Promise((resolve, reject) => {
        db.find({"airport":airport}, {"_id": 0, "__v":0}).sort({occupied : -1, apron:1 }).exec((err, result) => {
            if (err) reject(err);
            resolve(result);
        });
    });
    return gate_list
}

async function get_all_possible_gates_for(airport, ac, apron_input){
    let [aprons, backup_aprons] = apron_input

    if(airport == "EBBR" && ac == "A388"){
        var super_gates = ["233R", "322", "328"]
        var gate_list = await new Promise((resolve, reject) => {
            db.find({"airport":airport, "gate":{ $in: super_gates}, "occupied":false}, {"_id": 0, "__v":0}).sort({apron: 1}).exec((err, result) => {
                if (err) reject(err);
                resolve(result);
            });
        });
        return (gate_list.length > 0 ? [gate_list[0]] : [])
    }
    /* Find all gates on specific apron */
    var gate_list = await new Promise((resolve, reject) => {
        db.find({"airport":airport, "apron": { $in: aprons}, "occupied":false}, {"_id": 0, "__v":0}).sort({apron: 1}).exec((err, result) => {
            if (err) reject(err);
            resolve(result);
        });
    });
    /* When all gates on apron are occupied, use backup apron*/
    if(gate_list.length == 0){
        gate_list = await new Promise((resolve, reject) => {
            db.find({"airport":airport, "apron": { $in: backup_aprons}, "occupied":false}, {"_id": 0, "__v":0}).sort({apron: 1}).exec((err, result) => {
                if (err) reject(err);
                resolve(result);
            });
        });
    }
    return gate_list
}

async function get_gate_for_gateid(airport, gate_id){
    var gate_obj = await new Promise((resolve, reject) => {
        db.findOne({"airport":airport, "gate": gate_id}, {"_id": 0, "__v":0}, (err, result) => {
            if (err) reject(err);
            resolve(result);
        });
    });
    return gate_obj
}

async function get_gate_for_callsign(callsign){
    var gate_obj = await new Promise((resolve, reject) => {
        db.findOne({"assigned_to" : callsign},{"_id": 0, "__v":0, "apron":0, "latitude":0, "longitude":0}, (err, result) => {
            if (err) reject(err);
            resolve(result);
        });
    });
    return gate_obj
}

async function set_gate_to_callsign(airport, gate_id, callsign){
    /* Check if gate exists */
    var gate_obj = await get_gate_for_gateid(airport, gate_id);
    if(gate_obj == null){
        if (DEBUG) console.log("ERR: gate " + gate_id + " does not exist");
        return {success: false, code: "GATE_NOT_EXIST", error: "Gate "+ gate_id+" does not exist"}
    }
    /* Check if gate is not occupied */
    if (gate_obj.occupied){ 
        if (DEBUG) console.log("ERR: gate " + gate_id + " already assigned to " + gate_obj.assigned_to);
        return {success: false, code: "GATE_OCCUPIED", error: "Gate "+ gate_id+ "already occupied"}
    }

    /* Check if callsign already has a reservation, if yes, return error*/
    var curr_reservation = await get_gate_for_callsign(callsign);
    if (curr_reservation != null){ 
        if (DEBUG) console.log("ERR: "+ callsign +" already assigned to gate: " + curr_reservation.gate)
        return {success: false, code: "CS_ALREADY_ASSIGNED", error: callsign + " already assigned to a gate"}
    }

    /* Update gate */
    gate_obj.occupied = true;
    gate_obj.assigned_to = callsign;
    var result_obj = await new Promise((resolve, reject) => {
        db.update({"airport":airport, "gate": gate_id}, gate_obj, function(err, result){
            if (err) reject(err);
            resolve(gate_obj);
        });
    });
    return {success: true, result: result_obj};
}

async function clear_gate(airport, gate_id){
    var gate_obj = await get_gate_for_gateid(airport, gate_id);
    gate_obj.occupied = false;
    gate_obj.assigned_to = "none";
    var result_obj = await new Promise((resolve, reject) => {
        db.update({"airport":airport, "gate": gate_id}, gate_obj, function(err, result){
            if (err) reject({success: false, error: err});
            resolve({success: true, result: gate_obj});
        });
    });
    return result_obj;
}


async function set_gate_for(callsign, airport, gateid){
    var old_gate_obj = await get_gate_for_callsign(callsign);
    /*Only clear old gate if callsign already has a gate assigned*/
    if(old_gate_obj != null && old_gate_obj.occupied){
        var result_obj = await clear_gate(old_gate_obj.airport, old_gate_obj.gate);
    }
    var new_gate = await set_gate_to_callsign(airport,gateid, callsign);
    return new_gate
}

async function request_gate_for(airport, callsign, origin, ac){
    var aprons = f.get_valid_aprons(airport, callsign,origin, ac);
    return await request_gate_on_apron(airport, callsign, ac, aprons);
}

async function request_gate_on_apron(airport, callsign, ac, apron){
    var gates_list = await get_all_possible_gates_for(airport, ac, apron);
    var temp_gate_obj = gates_list[Math.floor(Math.random() * gates_list.length)];

    var result_obj = await set_gate_to_callsign(airport, temp_gate_obj.gate, callsign)
    while(!result_obj.success){
        var temp_gate_obj = gates_list[Math.floor(Math.random() * gates_list.length)];
        var result_obj = await set_gate_to_callsign(airport, temp_gate_obj.gate, callsign)
    }
    return result_obj
}

async function load_active_clients(){
    // var intresting_clients = await fetch('https://data.vatsim.net/v3/vatsim-data.json')
    var intresting_clients = await fetch('https://api.beluxvacc.org/belux-active-runways/vatsim-clients', {
        headers: {
          "Authorization": 'Basic YmVsdXhfY2xpZW50XzIwMjE6T2ZlZEN1enRRSW1PemN3Z2h3cjU1QQ=='
        }
    })
    .then(res => {
        if(!res.ok){ console.error("failed vatsim json fetch"); throw res}
        return res.json()
    })
    .then((out) => {
        pilots_of_interest = []
        controllers_of_interest = []
        var i;
        for(i=0; i< out.pilots.length;i++){
            var client =  out.pilots[i]
            var location_client = {"latitude": client.latitude, "longitude": client.longitude} 
            if(client.flight_plan != null){
                if (airports_of_interest.includes(client.flight_plan.departure) && f.worldDistance(location_client, location_coordinates[client.flight_plan.departure]) < 300){
                    pilots_of_interest.push(client)
                }
                else if (airports_of_interest.includes(client.flight_plan.arrival)  && f.worldDistance(location_client, location_coordinates[client.flight_plan.arrival]) < 300){
                    pilots_of_interest.push(client)
                }
            }
        }
        for(i=0;i< out.controllers.length;i++){
            var client = out.controllers[i]
            var belux_positions = ["EBBU", "EBBR", "EBOS", "EBAW", "EBCI", "EBLG" , "ELLX"]
            if (belux_positions.includes(client.callsign.substring(0,4))){
                controllers_of_interest.push(client)
            }
        }

        return { "pilots": pilots_of_interest, "controllers": controllers_of_interest}
    })
    .catch((err) => {
        return null;
    });
    if(intresting_clients != null){
        last_updated = Date.now()
        return await process_clients(intresting_clients)
    }
}

async function process_clients(clients){
    var i, output_pilots=[], output_controllers=[];
    for (const [key, client] of Object.entries(clients.pilots)) {
        var callsign = client.callsign
        var lat = client.latitude,
            long = client.longitude,
            altitude = client.altitude,
            status = "UNKNOWN",
            arr_distance = '',
            ETA = '',
            ETA_till_gate = '',
            AC_code = client.flight_plan.aircraft.split("/")[0];
            ground_speed = client.groundspeed
        
        if (AC_code.length==1){
            AC_code = client.flight_plan.aircraft.split("/")[1];
        }

        var on_dep_ground = (client.flight_plan.departure in f.airport_zones ?  f.is_on_zone(f.airport_zones[client.flight_plan.departure], lat, long, altitude) : false);
        var on_arr_ground = (client.flight_plan.arrival in f.airport_zones ?  f.is_on_zone(f.airport_zones[client.flight_plan.arrival], lat, long, altitude) : false);

        if (on_dep_ground || on_arr_ground){
            var closestGate = f.get_gate_for_position(lat, long);
            // CHECK gate reservation OK
            if (closestGate == null){
                status = "taxing"
                if ( callsign in monitored_clients && monitored_clients[callsign] == "AUTO-DEP"){
                    var gate_obj = await get_gate_for_callsign(callsign);
                    if(gate_obj!=null){
                        var result_obj = await clear_gate(gate_obj.airport, gate_obj.gate); 
                        if(result_obj.success){
                            delete monitored_clients[callsign]
                            if (DEBUG) console.log("deleted " + callsign)
                        }
                    }
                }
            }else{
                // AC is at gate
                status = "at_gate"
                var cur_gate = await get_gate_for_callsign(callsign);
                if (cur_gate == null){
                    let gate_obj = await get_gate_for_gateid(closestGate.airport, closestGate.gate);
                    if(gate_obj.occupied == true){
                        /* Gate was already assigned => double booking
                           Make new reservation for that other client */
                        var other_callsign = gate_obj.assigned_to;
                        var other_apron = gate_obj.apron;
                        var other_airport = gate_obj.airport
                        var result_obj = await clear_gate(gate_obj.airport, gate_obj.gate);
                        if (!result_obj.success && DEBUG) console.log(result_obj)

                        result_obj = await request_gate_on_apron(other_airport, other_callsign, "ZZZ", [[other_apron], [other_apron]]);
                        if (!result_obj.success && DEBUG) console.log(result_obj)
                    }
                    var result_obj = await set_gate_to_callsign(gate_obj.airport,gate_obj.gate, callsign); 
                    if (!result_obj.success && DEBUG) console.log(result_obj)

                    monitored_clients[callsign] = "AUTO-DEP"
                    load_active_clients();
                }
            }
        }else{
            if(airports_of_interest.includes(client.flight_plan.departure)){
                status = "departed"
                if ( callsign in monitored_clients && monitored_clients[callsign] == "AUTO-DEP"){
                    var gate_obj = await get_gate_for_callsign(callsign)
                    if(gate!=null){
                        var result_obj = await clear_gate(gate_obj.airport, gate_obj.gate); 
                        if(result_obj.success){
                            delete monitored_clients[callsign]
                            if (DEBUG) console.log("deleted " + callsign)
                        }
                    }
                }
            }else{
                var location_client = {"latitude": lat, "longitude": long} 
                var dest_airport = (client.flight_plan.arrival=="EBBR"?"EBCI": client.flight_plan.arrival) //Hack for south arrivals in brussels
                arr_distance = parseInt(f.worldDistance(location_client, location_coordinates[dest_airport]))
                if(parseInt(ground_speed) < 50)
                    /* not yet departed from origin*/
                    continue
                if (arr_distance < 150){
                    var cur_gate = await get_gate_for_callsign(callsign);
                    if (cur_gate == null){
                        var result_obj = await request_gate_for(client.flight_plan.arrival, callsign, client.flight_plan.departure, AC_code)
                        if (!result_obj.success && DEBUG) console.log(result_obj)
                        monitored_clients[callsign] = "AUTO_ARR"
                    }
                }
                ETA = parseInt(arr_distance/parseInt(ground_speed)*60);
                ETA_till_gate = parseInt((arr_distance-150)/parseInt(ground_speed)*60)
                status = "arriving"
            }
        }
        var result_obj = await get_gate_for_callsign(callsign);
        var gate = (result_obj== null ? "": (result_obj.gate)) 
        output_pilots.push(
            {"type"     : (airports_of_interest.includes(client.flight_plan.departure) ? "D":"A"),
             "callsign" : callsign, 
             "arr_airport"  : client.flight_plan.arrival,
             "dep_airport"   : client.flight_plan.departure,
             "ac"       : AC_code,
             "status"   : status,
             "distance" : arr_distance,
             "eta"      : ETA,
             "eta_till_gate": ((ETA_till_gate) > 0 ? (ETA_till_gate +1) : ''),
             "reservation": (arr_distance < 150 ?gate : '')
            }
        );
    }
    for (const [key, client] of Object.entries(clients.controllers)) {
        output_controllers.push(
            {
                "callsign"      : client.callsign,
                "logon_time"    : client.logon_time,
                "name"          : client.name,
                "frequency"     : client.frequency     
            }
        )
    }

    pilots_of_interest = output_pilots
    controllers_of_interest = output_controllers
    return {"status": "ok"}
}

function bookkeep_clients(){
    Object.keys(monitored_clients).forEach(async function(key){
        var i, found=false;
        for (i=0;i<pilots_of_interest.length;i++){
            if (pilots_of_interest[i]["callsign"] == key)
                found = true
        }
        if (!found){
            if (DEBUG) console.log("cleaning up " + key)
            var gate_obj = await get_gate_for_callsign(key);
            if(gate_obj != null){
                var result_obj = await clear_gate(gate_obj["airport"], gate_obj["gate"]);
                if (!result_obj.success && DEBUG) console.log(result_obj)
                delete monitored_clients[key]
            }
        }
    });
}

setTimeout(load_active_clients, 2*1000);
setInterval(load_active_clients, 90*1000);
setInterval(bookkeep_clients, 120*1000);

/* API FUNCTIONS */

/* /GET/all_gates */
exports.list_all_gates = async function(req, res) {
    var gates = await get_all_gates()
    res.json(gates);
};

/* /GET/all_gates/:airport/ */
exports.list_all_gates_for_airport = async function(req, res) {
    airport = req.params.airport.toUpperCase();
    var gates = await get_all_gates_for_airport(airport)
    res.json(gates);
};

/* /POST/all_gates/:airport/ */
exports.list_all_valid_gates = async function(req, res) {
    airport = req.params.airport.toUpperCase();;
    callsign = req.body.callsign;
    origin = req.body.origin;
    ac = req.body.aircraft;

    var aprons = f.get_valid_aprons(airport, callsign, origin, ac)
    var gates =  await get_all_possible_gates_for(airport, ac, aprons)
    res.json(gates)
};

/* /GET/get_gate/:gateid*/
exports.get_gate_for_id = async function(req, res){
    airport = req.params["airport"].toUpperCase();;
    gate_id = req.params["gateid"];

    var gate = await get_gate_for_gateid(airport, gate_id)
    res.json(gate == null? [] : gate);
};

/* /POST/get_gate*/
exports.get_gate_for_callsign = async function(req, res){
    callsign = req.body.callsign;
    
    var gate = await get_gate_for_callsign(callsign)
    res.json(gate == null? [] : gate)
}

/* /POST/set_random_gate */
exports.set_random_gate = async function(req, res){
    callsign = req.body.callsign;
    airport = req.body.airport.toUpperCase();;
    origin = req.body.origin;
    ac = req.body.aircraft;

    var result_obj = await request_gate_for(airport,callsign, origin, ac);
    if (!result_obj.success){
        res.status(500).send(
        {
            error: {
                status: 500,
                message: result_obj.error,
            }
        });
    }else{
        res.json(result_obj.result)
        monitored_clients[callsign] = "MANUAL"
        load_active_clients();
    }
};

/* /POST/set_gate */
exports.set_gate = async function(req, res){
    callsign = req.body.callsign;
    requested_airport = req.body.airport;
    requested_gateid = req.body.gate_id;


    result_obj = await set_gate_for(callsign, requested_airport, requested_gateid)
    if (!result_obj.success){
        res.status(500).send(
        {
            error: {
                status: 500,
                message: result_obj.error,
            }
        });
    }else{
        res.json(result_obj.result)
        monitored_clients[callsign] = "MANUAL"
        load_active_clients();
    }
}

/* /POST/clear_gate/ */
exports.clear_gate = async function(req, res){
    callsign = req.body.callsign;
    var gate_obj = await get_gate_for_callsign(callsign);
    if(gate_obj == null){
        res.status(500).send(
            {
                error: {
                    status: 500,
                    message: "Callsign is not assigned to gate",
                }
            });
    }

    var result_obj = await clear_gate(gate_obj.airport, gate_obj.gate)
    if (!result_obj.success){
        res.status(500).send(
        {
            error: {
                status: 500,
                message: result_obj.error,
            }
        });
    }else{
        delete monitored_clients[callsign]
        res.json(result_obj.result)
        load_active_clients();
    }
}

/* /GET/get_pilots */
exports.get_active_pilots = function(req, res){
    airport = req.params.airport.toUpperCase();
    if(pilots_of_interest != null){
        filtered_clients = pilots_of_interest.filter(function(el){
            return el.arr_airport == airport || el.dep_airport == airport
        });
        res.json({"updated": last_updated, "clients": filtered_clients});
    }else{
        res.json({"updated": last_updated, "clients": null});
    }
}

/* /GET/get_controllers */
exports.get_active_controllers = function(req, res){
    res.json({"updated": last_updated, "clients": controllers_of_interest});
}

/* /GET/force_get_clients */
exports.force_reload_clients= async function(req, res){
    await load_active_clients()
    res.json({"status": "OK"})
}


exports.get_available_airports = function(req, res){
    res.json([
        {  "icao"      : "EBBR",
           "active"    : true,
        },
        {
            "icao"     : "ELLX",
            "active"   : true,
        },
        {
            "icao"     : "EBCI",
            "active"   : false,
        },
        {
            "icao"     : "EBOS",
            "active"   : false,
        },
        {
            "icao"     : "EBAW",
            "active"   : false,
        },
        {
            "icao"     : "EBLG",
            "active"   : false,
        },
    ])
}