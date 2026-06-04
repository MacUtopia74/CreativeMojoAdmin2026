import { useState, useEffect } from "react";
import api from "@/lib/api";
import { API_BASE } from "@/lib/api";
import { Plus, Edit, Trash2, Users, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";


const emptyClient = {
  name: "",
  email: "",
  email2: "",
  phone: "",
  address: "",
  city: "",
  country: "",
  show_name: true,
  show_email: true,
  show_email2: true,
  show_phone: false,
  show_address: true,
  show_city: true,
  show_country: true,
};

const Clients = () => {
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingClient, setEditingClient] = useState(null);
  const [formData, setFormData] = useState(emptyClient);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchClients();
  }, []);

  const fetchClients = async () => {
    try {
      const response = await api.get("/invoices/clients");
      setClients(response.data);
    } catch (error) {
      toast.error("Failed to fetch clients");
    } finally {
      setLoading(false);
    }
  };

  const openCreateDialog = () => {
    setEditingClient(null);
    setFormData(emptyClient);
    setDialogOpen(true);
  };

  const openEditDialog = (client) => {
    setEditingClient(client);
    setFormData({
      name: client.name,
      email: client.email || "",
      email2: client.email2 || "",
      phone: client.phone || "",
      address: client.address || "",
      city: client.city || "",
      country: client.country || "",
      show_name: client.show_name !== false,
      show_email: client.show_email !== false,
      show_email2: client.show_email2 !== false,
      show_phone: client.show_phone || false,
      show_address: client.show_address !== false,
      show_city: client.show_city !== false,
      show_country: client.show_country !== false,
    });
    setDialogOpen(true);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (!formData.name) {
      toast.error("Name is required");
      return;
    }

    setSaving(true);
    try {
      if (editingClient) {
        await api.put(`/invoices/clients/${editingClient.id}`, formData);
        toast.success("Client updated successfully");
      } else {
        await api.post("/invoices/clients", formData);
        toast.success("Client created successfully");
      }
      setDialogOpen(false);
      fetchClients();
    } catch (error) {
      toast.error(editingClient ? "Failed to update client" : "Failed to create client");
    } finally {
      setSaving(false);
    }
  };

  const deleteClient = async (clientId) => {
    try {
      await api.delete(`/invoices/clients/${clientId}`);
      toast.success("Client deleted successfully");
      fetchClients();
    } catch (error) {
      toast.error("Failed to delete client");
    }
  };

  return (
    <div className="space-y-8" data-testid="clients-page">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-4xl font-bold tracking-tight font-display" data-testid="page-title">
            Clients
          </h1>
          <p className="text-muted-foreground mt-1">
            Manage your client database
          </p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button className="gap-2 rounded-full px-6" onClick={openCreateDialog} data-testid="add-client-btn">
              <Plus className="w-4 h-4" />
              Add Client
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="">
                {editingClient ? "Edit Client" : "Add New Client"}
              </DialogTitle>
            </DialogHeader>
            <form onSubmit={handleSubmit} className="space-y-4 mt-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="col-span-2 flex items-start gap-3">
                  <div className="flex-1">
                    <Label>Name *</Label>
                    <Input
                      className="mt-2"
                      placeholder="Client name"
                      value={formData.name}
                      onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                      data-testid="client-name-input"
                    />
                  </div>
                  <div className="flex items-center gap-2 mt-8">
                    <Checkbox
                      id="show_name"
                      checked={formData.show_name}
                      onCheckedChange={(checked) => setFormData(prev => ({ ...prev, show_name: checked }))}
                    />
                    <Label htmlFor="show_name" className="text-xs text-muted-foreground">Show</Label>
                  </div>
                </div>
                <div className="col-span-2 flex items-start gap-3">
                  <div className="flex-1">
                    <Label>Email</Label>
                    <Input
                      type="email"
                      className="mt-2"
                      placeholder="client@example.com"
                      value={formData.email}
                      onChange={(e) => setFormData(prev => ({ ...prev, email: e.target.value }))}
                      data-testid="client-email-input"
                    />
                  </div>
                  <div className="flex items-center gap-2 mt-8">
                    <Checkbox
                      id="show_email"
                      checked={formData.show_email}
                      onCheckedChange={(checked) => setFormData(prev => ({ ...prev, show_email: checked }))}
                    />
                    <Label htmlFor="show_email" className="text-xs text-muted-foreground">Show</Label>
                  </div>
                </div>
                <div className="col-span-2 flex items-start gap-3">
                  <div className="flex-1">
                    <Label>Email 2</Label>
                    <Input
                      type="email"
                      className="mt-2"
                      placeholder="alternate@example.com"
                      value={formData.email2}
                      onChange={(e) => setFormData(prev => ({ ...prev, email2: e.target.value }))}
                      data-testid="client-email2-input"
                    />
                  </div>
                  <div className="flex items-center gap-2 mt-8">
                    <Checkbox
                      id="show_email2"
                      checked={formData.show_email2}
                      onCheckedChange={(checked) => setFormData(prev => ({ ...prev, show_email2: checked }))}
                    />
                    <Label htmlFor="show_email2" className="text-xs text-muted-foreground">Show</Label>
                  </div>
                </div>
                <div className="col-span-2 flex items-start gap-3">
                  <div className="flex-1">
                    <Label>Phone</Label>
                    <Input
                      className="mt-2"
                      placeholder="+1 234 567 8900"
                      value={formData.phone}
                      onChange={(e) => setFormData(prev => ({ ...prev, phone: e.target.value }))}
                      data-testid="client-phone-input"
                    />
                  </div>
                  <div className="flex items-center gap-2 mt-8">
                    <Checkbox
                      id="show_phone"
                      checked={formData.show_phone}
                      onCheckedChange={(checked) => setFormData(prev => ({ ...prev, show_phone: checked }))}
                    />
                    <Label htmlFor="show_phone" className="text-xs text-muted-foreground">Show</Label>
                  </div>
                </div>
                <div className="col-span-2 flex items-start gap-3">
                  <div className="flex-1">
                    <Label>Address</Label>
                    <Input
                      className="mt-2"
                      placeholder="Street address"
                      value={formData.address}
                      onChange={(e) => setFormData(prev => ({ ...prev, address: e.target.value }))}
                      data-testid="client-address-input"
                    />
                  </div>
                  <div className="flex items-center gap-2 mt-8">
                    <Checkbox
                      id="show_address"
                      checked={formData.show_address}
                      onCheckedChange={(checked) => setFormData(prev => ({ ...prev, show_address: checked }))}
                    />
                    <Label htmlFor="show_address" className="text-xs text-muted-foreground">Show</Label>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <div className="flex-1">
                    <Label>City</Label>
                    <Input
                      className="mt-2"
                      placeholder="City"
                      value={formData.city}
                      onChange={(e) => setFormData(prev => ({ ...prev, city: e.target.value }))}
                      data-testid="client-city-input"
                    />
                  </div>
                  <div className="flex items-center gap-2 mt-8">
                    <Checkbox
                      id="show_city"
                      checked={formData.show_city}
                      onCheckedChange={(checked) => setFormData(prev => ({ ...prev, show_city: checked }))}
                    />
                    <Label htmlFor="show_city" className="text-xs text-muted-foreground">Show</Label>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <div className="flex-1">
                    <Label>Country</Label>
                    <Input
                      className="mt-2"
                      placeholder="Country"
                      value={formData.country}
                      onChange={(e) => setFormData(prev => ({ ...prev, country: e.target.value }))}
                      data-testid="client-country-input"
                    />
                  </div>
                  <div className="flex items-center gap-2 mt-8">
                    <Checkbox
                      id="show_country"
                      checked={formData.show_country}
                      onCheckedChange={(checked) => setFormData(prev => ({ ...prev, show_country: checked }))}
                    />
                    <Label htmlFor="show_country" className="text-xs text-muted-foreground">Show</Label>
                  </div>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">* Use "Show" checkboxes to control what appears on invoices</p>
              <div className="flex justify-end gap-2 pt-4">
                <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={saving} data-testid="save-client-btn">
                  {saving ? "Saving..." : editingClient ? "Update Client" : "Add Client"}
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {/* Clients Table */}
      {loading ? (
        <div className="text-center py-12">
          <p className="text-muted-foreground">Loading clients...</p>
        </div>
      ) : clients.length === 0 ? (
        <Card className="p-12 text-center">
          <Users className="w-12 h-12 mx-auto text-muted-foreground/50" />
          <h3 className="text-lg font-semibold mt-4">No clients yet</h3>
          <p className="text-muted-foreground mt-1">
            Add your first client to start creating invoices
          </p>
          <Button className="mt-6 gap-2" onClick={openCreateDialog} data-testid="empty-add-client-btn">
            <Plus className="w-4 h-4" />
            Add Client
          </Button>
        </Card>
      ) : (
        <Card className="overflow-hidden" data-testid="clients-table">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/50">
                <TableHead className="font-semibold">Name</TableHead>
                <TableHead className="font-semibold">Email</TableHead>
                <TableHead className="font-semibold hidden md:table-cell">Phone</TableHead>
                <TableHead className="font-semibold hidden lg:table-cell">Location</TableHead>
                <TableHead className="text-right font-semibold">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {clients.map((client) => (
                <TableRow key={client.id} className="hover:bg-muted/30" data-testid={`client-row-${client.id}`}>
                  <TableCell className="font-medium">{client.name}</TableCell>
                  <TableCell className="text-muted-foreground">{client.email}</TableCell>
                  <TableCell className="text-muted-foreground hidden md:table-cell">{client.phone || "—"}</TableCell>
                  <TableCell className="text-muted-foreground hidden lg:table-cell">
                    {[client.city, client.country].filter(Boolean).join(", ") || "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => openEditDialog(client)}
                        data-testid={`edit-client-${client.id}`}
                      >
                        <Edit className="w-4 h-4" />
                      </Button>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant="ghost" size="icon" data-testid={`delete-client-${client.id}`}>
                            <Trash2 className="w-4 h-4 text-destructive" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Delete Client?</AlertDialogTitle>
                            <AlertDialogDescription>
                              This will permanently delete {client.name}. This action cannot be undone.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() => deleteClient(client.id)}
                              className="bg-destructive text-destructive-foreground"
                            >
                              Delete
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
};

export default Clients;
