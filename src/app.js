const express = require('express');
const morgan = require('morgan');
const mustache_express = require('mustache-express');//https://www.npmjs.com/package/python-struct
const path = require('path');
const fs = require('fs');
const struct = require('python-struct');
//const filesize = require('filesize'); filesize didn't work for me, using getFileSize() function
const { exec } = require('child_process');

const port = process.env.PORT;
const static_files_path = process.env.STATIC_FILES;
const ps4_ip = process.env.PS4IP;
const local_ip = process.env.LOCALIP;

const ps4_api_uri_get_task_progress = `http://${ps4_ip}:12800/api/get_task_progress`;
const ps4_api_uri_install = `http://${ps4_ip}:12800/api/install`;

const package_types = {26:"GAME",
						27:"DLC",
						28:"PATCH",
						29:"License"
						}

var pkg_wip = false;
var pkg_wip_filename='';
var pkg_wip_meta;
var pkg_task_id;



const app = express();
app.use(morgan('combined'));
app.use(express.urlencoded());



app.engine('html', mustache_express());
app.set('view engine', 'html');
app.set('views', __dirname + '/views');

//sets folder to retrieve icons
app.use('/icons', express.static('/opt/apps/pkg_sender/src/views/icons/'));

app.get('/', function (req, res) {
	console.log(`pkg_wip: ${pkg_wip} && pkg_wip: ${pkg_wip_filename}`);
	if (!pkg_wip){
		res.render('index', {"pkgs": get_pkgs()} );
	}
	else{
		ps4_install_status(pkg_task_id,res);
	}
});

app.post('/install', function(req, res) {
  const filepath = req.body.filepath;
  pkg_wip_filename = filepath;
  pkg_wip_meta = get_pkg_info(filepath,false);
  
  const dirname = path.dirname(filepath);
  app.use(express.static(dirname));
  const filename = path.basename(filepath);
  ps4_install(filename, res);
});

app.get('/get', function (req, res) {
	var query_TaskId = req.query.taskId;
	//res.send("taskId is set to " + req.query.taskId);
	ps4_install_status(query_TaskId,res);
});

app.get('/files', function(req, res) {
	res.setHeader("Content-Type", "text/html")
	
	const filepath = req.body.filepath;
	pkg_wip_filename = filepath;
	pkg_wip_meta = get_pkg_info(filepath,true);
  
	var icon_stat = get_saved_icon(filepath);
	if (icon_stat.status){
		
		res.write(`<img src='/icons/${path.basename(icon_stat.address)}' width="100" height="100"><br>`);
	}
  
	res.write(JSON.stringify(pkg_wip_meta));
	res.send();
});

app.listen(port, function () {
  console.log(`PS4 PKG sender listening on port ${port} serving files from ${static_files_path}`);
});

function getFileSize(size) {
  //Credits: https://gist.github.com/narainsagar/5cfd315ab38ba363191b63f8ae8b27db
  // convert to human readable format.
  const i = Math.floor(Math.log(size) / Math.log(1024));
  return (size / Math.pow(1024, i)).toFixed(2) * 1 + ' ' + ['B', 'KB', 'MB', 'GB', 'TB'][i];
}

function parse_response(rawJSON){
	//Using this regex we are going to fix the JSON, from having hex numbers to just numbers.
	//Thanks to this fix we can parse de JSON.
	const regex = /\b(0x[\d\w]{1,})\b/g;
	var found = rawJSON.match(regex);
	if (found != null){
		for (let i = 0; i < found.length; i++) {
			let val_dec = parseInt(found[i],16);
			rawJSON = rawJSON.replace(found[i],val_dec)
			}
	}
	return JSON.parse(rawJSON)	
}

function get_dirs_with_pkgs() {
  const pkgs = get_pkgs();
  const dirs = {};
  for(var i = 0, l = pkgs.length; i < l; ++i){
    dirs[pkgs[i].dir] = true;
  }
  return Object.keys(dirs);
}

function get_pkgs() {
  const walkSync = function(dir, filelist) {
    const files = fs.readdirSync(dir);
    files.forEach(function(file) {
      filepath = dir + '/' + file;
      const stat = fs.statSync(filepath);
      if (stat.isDirectory()) {
        filelist = walkSync(filepath, filelist);
      } else if (path.extname(file).toLowerCase() === '.pkg') {
		let pkg_info = get_pkg_info(filepath,true);
		filelist.push({
		  filepath: filepath,
		  dir: path.dirname(filepath),
		  name: path.basename(filepath),
		  short_dir: path.dirname(filepath).replace(static_files_path, ""),
		  size: getFileSize(stat.size),
		  pkg_id: pkg_info[13],
		  pkg_type:package_types[pkg_info[16]],
		  iconfile:pkg_info[27],
		});
      }
    });
    return filelist;
  };
  return walkSync(static_files_path, []);
}

function get_saved_icon(filepath){
	var icon_name = path.basename(filepath).replace('pkg', 'png');
	var icon_adress = `/opt/apps/pkg_sender/src/views/icons/${icon_name}`;

	try {
		fs.accessSync(icon_adress);
		status = true;
		} catch (err) {
			console.error(`file: ${icon_adress} doesn't exist`);
			status = false;
		}

	return {"status": status, "address": icon_adress}
}

function get_pkg_info(filename,getFiles){
	//inspired by https://github.com/mc-17/ps4_pkg_tool
	console.log(filename)
	const header_format = '>5I2H2I4Q36s12s12I';
	const entry_format = ">6IQ";
	
	var header_buffer = new Buffer.alloc(160);
	var files_buffer = new Buffer.alloc(32);

	var fd = fs.openSync(filename, 'r')
	fs.readSync(fd, header_buffer, 0, header_buffer.length,null)
	var data = header_buffer.toString("utf8");
	var pkg_header = struct.unpack(header_format,header_buffer);
	
	var icon_name = path.basename(filename).replace('pkg', 'png')
	var icon_adress = `/opt/apps/pkg_sender/src/views/icons/${icon_name}`;
	
	try {
		fs.accessSync(icon_adress);
		getFiles = false
		} catch (err) {
			console.error(`file: ${icon_adress} doesn't exist`);
		}
	
	if (getFiles){
		let pkg_entry_count = pkg_header[4]
		let pkg_table_offset = pkg_header[7]
		var files = {};
		fd = fs.openSync(filename, 'r')
		for (let i = 0; i <= pkg_entry_count; i++) {
			
			let file_offset = pkg_table_offset + (i*files_buffer.length);	
			fs.readSync(fd, files_buffer, 0, files_buffer.length,file_offset);
			var file_struct = struct.unpack(entry_format,files_buffer);
			
			files[file_struct[0]] = {
								"fn_offset": file_struct[1],
								"flags1": file_struct[2],
								"flags2": file_struct[3],
								"offset": file_struct[4],
								"size": file_struct[5],
								"padding": file_struct[6]
								}							
			}
		console.log('Trying to get icon.img')
		if(4608 in files){
			var icon_buffer = new Buffer.alloc(files[4608].size);
			fs.readSync(fd, icon_buffer, 0, icon_buffer.length,files[4608].offset);
			var fr = fs.writeFileSync(icon_adress, icon_buffer);
		} else{
			fs.copyFileSync('/opt/apps/pkg_sender/src/views/no_icon.png',icon_adress)
		}
	}
	
	pkg_header[27] = `/icons/${icon_name}`;
	//13 pkg_content_id
	//16 pkg_sub_type
	return pkg_header
}

function ps4_install_status(pkg_task_id,res) {	
	var curl_command_get_task_progress = `curl -v "${ps4_api_uri_get_task_progress}" --data '{"task_id":${pkg_task_id}}'`;
	
	
	res.setHeader("Content-Type", "text/html");
	
	if (typeof pkg_wip_meta !== 'undefined'){
		let pkg_content_id = pkg_wip_meta[13];
		let pkg_sub_type = pkg_wip_meta[16];
		res.write(`Sending:[${package_types[pkg_wip_meta[16]]}]  ${pkg_content_id} -- TaskID:${pkg_task_id} <br>`);
	};
	

	console.log(curl_command_get_task_progress);
	exec(curl_command_get_task_progress, (err, stdout, stderr) => {
		if (err) {
		  res.write(err);
		  res.end();
		  console.error(err);
		  //return;
		}
		res.write(`stdout: ${stdout}<br>`);
		console.log(`stdout: ${stdout}`);
		console.log(`stderr: ${stderr}`);
		let task_progress_status = parse_response(stdout)
		if(task_progress_status.status =="success"){
			let transfered_perc = ((task_progress_status.transferred_total/task_progress_status.length_total)*100).toFixed(2);			
			let str_transfered_ratio = `${getFileSize(task_progress_status.transferred_total)}/${getFileSize(task_progress_status.length_total)}`;			
			res.write(`transferred: ${str_transfered_ratio} ${transfered_perc}% <br>`);
			res.write(`time_left: ${task_progress_status.rest_sec_total}(s) <br>`);
			if(task_progress_status.rest_sec_total==0){
				pkg_wip=false;
			}
			res.end();
		}
		else{
			pkg_wip=false;//
		}
		res.end();
		});
}

function ps4_install(filename, res) {
  var pkg_uri = `http://${local_ip}:${port}/${encodeURI(filename)}`;
  var curl_command = `curl -v "${ps4_api_uri_install}" --data '{"type":"direct","packages":["${pkg_uri}"]}'`;
  res.setHeader("Content-Type", "text/html");
  res.write(curl_command);
  console.log(curl_command);
  exec(curl_command, (err, stdout, stderr) => {
    if (err) {
      res.write(err);
      res.end();
      console.error(err);
      return;
    }
    res.write(`stdout: ${stdout}`);
    console.log(`stdout: ${stdout}`);
	let find_task_status = parse_response(stdout)
	if(find_task_status.status =="success"){
		res.write(`<br><br><a href="/get?taskId=${find_task_status.task_id}">Check task #${find_task_status.task_id}</a>`);
		pkg_task_id=find_task_status.task_id;
		pkg_wip=true;
	}
    res.end();
  });
}
